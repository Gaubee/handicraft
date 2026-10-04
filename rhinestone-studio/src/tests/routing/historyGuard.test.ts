/*
 * [unify-studio-routing] history 收编守卫：src 内（排除测试目录与路由层白名单文件）
 * 零直接 history 调用——pushState/replaceState 与 location.hash 写一律经
 * router.svelte.ts 单出口（writeHash/navigate/stripSearchParams/resetRouterForTests）。
 * 防回归：新增零散 history 写会破坏「URL 写入单源」的收编口径（proposal 验收：
 * 全仓 pushState/replaceState 零散调用清零）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '../../')
const WHITELIST = new Set(['router.svelte.ts']) // 路由层单出口（writeHash/navigate/…）

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules' || entry === '.svelte-kit') continue
      out.push(...walk(full))
    } else if (/\.(ts|svelte|js)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** 调用形匹配（注释中的名词提及不误伤——须是 `xxx.pushState(`/`replaceState(` 调用形）。 */
const HISTORY_CALL = /\.(pushState|replaceState)\s*\(/
/** location.hash 写（读不拦；=== 比较不拦）。 */
const HASH_ASSIGN = /location\.hash\s*=[^=]/

describe('history 收编守卫（unify-studio-routing）', () => {
  it('src 内（排除测试与 router 白名单）零 pushState/replaceState 调用', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (WHITELIST.has(path.basename(file))) continue
      const text = readFileSync(file, 'utf8')
      if (HISTORY_CALL.test(text)) offenders.push(`${path.relative(SRC_ROOT, file)}: pushState/replaceState 调用`)
    }
    expect(offenders, `零散 history 调用须收编 router.svelte.ts：\n${offenders.join('\n')}`).toEqual([])
  })

  it('src 内（排除测试与 router 白名单）零 location.hash 写', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (WHITELIST.has(path.basename(file))) continue
      const text = readFileSync(file, 'utf8')
      if (HASH_ASSIGN.test(text)) offenders.push(`${path.relative(SRC_ROOT, file)}: location.hash 写`)
    }
    expect(offenders, `location.hash 写须收编 router.svelte.ts（navigate/writeHash）：\n${offenders.join('\n')}`).toEqual([])
  })
})
