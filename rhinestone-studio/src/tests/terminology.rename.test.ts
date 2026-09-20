/**
 * 术语改名断言（TERMS v4：「参考图/参考原图」→「原图」；Owner 2026-09-20 原话）：
 * 非测试源码面（UI 文案 + 注释）不得残留「参考图 / 参考原图」。
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

describe('TERMS v4 改名断言：「参考图/参考原图」→「原图」', () => {
  it('非测试源码面零残留（模型面骨架宿主与「蓝图参考图」除外）', () => {
    const violations: string[] = []
    for (const rel of collectFiles(SRC_ROOT)) {
      if (ALLOW_FILES.has(rel)) continue
      const text = readFileSync(join(SRC_ROOT, rel), 'utf-8')
      // 「蓝图参考图」是不同概念（blueprint refs）——剥除后判定
      const residue = text.replaceAll('蓝图参考图', '').match(/参考图|参考原图/g)
      if (residue !== null) violations.push(`${rel}: ${residue.length} 处`)
    }
    expect(violations, `改名残留（需改「原图」或登记白名单）：\n${violations.join('\n')}`).toEqual([])
  })
})
