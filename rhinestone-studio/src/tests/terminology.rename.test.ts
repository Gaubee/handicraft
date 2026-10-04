/**
 * 术语改名断言（TERMS v5；沿革 v4「参考图/参考原图」→「原图」Owner 2026-09-20）：
 * - v5（Owner 2026-10-04）：「参考图层」为新产品概念定名（add-flat-aux-segmentation——
 *   分件参考真源 reference image），「参考图」三字全域解禁（其合法简称）；
 * - 「原图」更名语义不变（源图概念仍称原图——v4 成果保持）；
 * - 旧复合词「参考原图」仍禁（v4 遗留词形，不再使用）。
 *
 * 白名单（design §6 冻结例外——不在本测试的失败面内）：
 * - `src/lib/lab/prompt.ts` / `src/lib/presets/effectRefs.ts`：模型面提示词骨架宿主
 *   （REFERENCE_FIGURE_LABEL='参考图' / figureOf('参考图') / 骨架注释引文——byteEq 红线，
 *   提示词字节不得漂移；两个文件内已加冻结注记）；
 * - 「蓝图参考图」：不同概念（blueprint refs），全域保留；
 * - `src/tests/**`：模型面提示词内容断言（快照/toContain 锁的是运行时冻结字面）；
 * - TERMS.md 历史注记/退役词映射（本测试不扫仓库根）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(process.cwd(), 'src')
const ALLOW_FILES = new Set(['lib/lab/prompt.ts', 'lib/presets/effectRefs.ts'])

function collectFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const rel = base === '' ? entry : `${base}/${entry}`
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (rel === 'tests' || rel === 'lib/components/ui') continue // 测试面/组件库面不扫
      out.push(...collectFiles(abs, rel))
    } else if (/\.(ts|svelte)$/.test(entry)) {
      out.push(rel)
    }
  }
  return out
}

describe('TERMS v5 断言：「参考图层」解禁（Owner 定名）/「参考原图」仍禁', () => {
  it('非测试源码面「参考原图」零残留（参考图/参考图层=合法产品术语）', () => {
    const violations: string[] = []
    for (const rel of collectFiles(SRC_ROOT)) {
      if (ALLOW_FILES.has(rel)) continue
      const text = readFileSync(join(SRC_ROOT, rel), 'utf-8')
      // 「蓝图参考图」不同概念剥除；「参考图/参考图层」v5 解禁不判——仅旧复合词「参考原图」残留判红
      const residue = text.replaceAll('蓝图参考图', '').match(/参考原图/g)
      if (residue !== null) violations.push(`${rel}: ${residue.length} 处`)
    }
    expect(violations, `改名残留（需改「原图」或登记白名单）：\n${violations.join('\n')}`).toEqual([])
  })
})
