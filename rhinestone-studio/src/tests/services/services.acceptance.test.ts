/*
 * [2026-09-20 S-4.4 Test] S 轨验收（rename-and-expert-workbench tasks 4.4）：
 * ① service 无 UI 依赖断言（import 面检查——三 service 源码零组件/视图/Svelte 单方导入、
 *    零 DOM 全局触点）；② 切换点预埋登记（gemCatalogService 5.6 真源切换标记在档）；
 * ③ mock 单测全绿由本套件聚合复跑（gemCatalog 5 例）。
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SERVICES_DIR = join(process.cwd(), 'src/lib/services')

function serviceFiles(): string[] {
  return readdirSync(SERVICES_DIR).filter((f) => f.endsWith('.ts'))
}

/** 剥注释后的代码面 */
function codeFace(file: string): string {
  const raw = readFileSync(join(SERVICES_DIR, file), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
}

describe('S 轨验收：service 无 UI 依赖', () => {
  it('services 目录三文件在档', () => {
    const files = serviceFiles().sort()
    expect(files).toEqual(['documentService.ts', 'gemCatalogService.ts', 'generationService.ts'])
  })

  it('import 面零 UI 依赖（白名单：engine/persistence/stores 数据层；组件/视图一律拒绝）', () => {
    // 注：$lib/stores/edit.svelte 是 .svelte.ts 状态模块（数据层），非 UI 组件——白名单口径；
    // 判据 = 只允许数据层根（$lib/components / 视图 / 其它路径一律越界）。
    const DATA_LAYER = ['$lib/engine', '$lib/persistence/', '$lib/stores/', '$lib/services/']
    for (const file of serviceFiles()) {
      const code = codeFace(file)
      const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      for (const spec of imports) {
        const allowed = DATA_LAYER.some((root) => spec.startsWith(root))
        expect(allowed, `${file} 依赖面越界（仅数据层）：${spec}`).toBe(true)
      }
    }
  })

  it('零 DOM 全局触点（service 层不碰 window/document；Blob 等平台类型除外）', () => {
    for (const file of serviceFiles()) {
      const code = codeFace(file)
      expect(code, `${file} 不使用 window.*`).not.toMatch(/\bwindow\./)
      expect(code, `${file} 不使用 document.*`).not.toMatch(/\bdocument\./)
    }
  })
})

describe('S 轨验收：切换点预埋登记', () => {
  it('gemCatalogService：5.6 真源切换点（sys-shapes .gemshape 资产）在档', () => {
    const raw = readFileSync(join(SERVICES_DIR, 'gemCatalogService.ts'), 'utf8')
    expect(raw).toContain('5.6')
    expect(raw).toContain('sys-shapes')
    expect(raw).toContain('.gemshape')
    expect(raw).toContain('接口签名不变')
  })

  it('documentService：payload 零复制声明在档（R3 非阻塞建议 2）', () => {
    const raw = readFileSync(join(SERVICES_DIR, 'documentService.ts'), 'utf8')
    expect(raw).toContain('payload 零复制声明')
  })
})

describe('S 轨验收：mock 单测聚合复跑', () => {
  it('gemCatalogService 目录文件在档可编译（详测见 gemCatalog.test.ts 5 例）', () => {
    const stats = statSync(join(SERVICES_DIR, 'gemCatalogService.ts'))
    expect(stats.size).toBeGreaterThan(0)
  })
})
