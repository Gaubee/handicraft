/*
 * [studio-layers 3.1] 术语表/产品模型文档契约（TERMS v3 + PRODUCT_MODEL v5 图层化升版的
 * CI grep 核对——tasks 3.1「术语与真源表 grep 核对（旧宿主措辞清零）」的 vitest 落地）：
 * - 版本登记在位（TERMS v3 / PM v5 头注含升版原因）；
 * - 图层化词条注册（图层/背景层/历史/观察态）+「排钻项目」定义补 layers + 分词注记在位；
 * - PM 真源表「排钻策略选择」宿主迁移（旧宿主「胶片带」措辞在真源表节内清零）+
 *   「图层结构与配置」/「观察态」行在位 + 硬规则补两条（隐藏层口径/多选批量单 op）。
 * 文档在应用根（TERMS.md / PRODUCT_MODEL.md——vitest cwd）；本文件只读不改。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

let terms = ''
let productModel = ''

beforeEach(async () => {
  // vitest cwd = 应用根（vite root）；import.meta.url 在 vite 管线下非 file: 协议，不可作路径源
  terms = await readFile(resolve(process.cwd(), 'TERMS.md'), 'utf8')
  productModel = await readFile(resolve(process.cwd(), 'PRODUCT_MODEL.md'), 'utf8')
})

/** 截取 markdown 指定 `## 标题` 节（至下一个 `## `）。 */
function sectionOf(doc: string, title: string): string {
  const start = doc.indexOf(`## ${title}`)
  if (start < 0) throw new Error(`找不到章节：${title}`)
  const next = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, next < 0 ? undefined : next)
}

describe('TERMS 版本头注契约（v3 图层化 → v4 原图改名）', () => {
  it('版本头注登记最新版与升版原因（v4 原图改名 + v3 studio-layers 图层化链均在位）', () => {
    // [placeholders v4] 「参考图」→「原图」词条改名 + 案例参照图功能开关语义
    expect(terms).toContain('状态：v4（2026-09-20，随 add-lab-effect-prompt-placeholders')
    expect(terms).toContain('参考图/参考原图 → 原图（v4）')
    // v3 图层化升版链保留（历史版本注记）
    expect(terms).toContain('随 studio-layers ④段图层化')
    expect(terms).toContain('两个「物理」不得混用')
  })

  it('[placeholders v4] 原图词条改名 + 案例参照图功能开关语义', () => {
    expect(terms).toMatch(/\| 原图 \|[^|]*用户要处理的目标图/)
    expect(terms).toContain('参考图、参考原图、底图')
    expect(terms).toMatch(/\| 案例参照图 \|[^|]*功能性开关效果/)
  })

  it('图层化词条注册：图层/背景层/历史/观察态（含禁用词列）', () => {
    expect(terms).toContain('| 图层 |')
    expect(terms).toContain('分组、分区')
    expect(terms).toContain('| 背景层 |')
    expect(terms).toContain('底图层')
    expect(terms).toContain('| 历史 |')
    expect(terms).toContain('不记计算结果')
    expect(terms).toContain('撤销历史、操作日志')
    expect(terms).toContain('| 观察态 |')
    expect(terms).toContain('不入 .gemproj、不入历史')
  })

  it('「排钻项目」定义补 layers（图层化参数全集入档口径）', () => {
    expect(terms).toMatch(/\| 排钻项目 \|[^|]*layers\[\]/)
  })

  it('「层参数 vs 画幅物理锚」分词注记在位（两「物理」分立）', () => {
    const note = sectionOf(terms, '分词注记')
    expect(note).toContain('层参数（层配置物理）')
    expect(note).toContain('画幅物理锚（PhysicalCanvas）')
  })
})

describe('PRODUCT_MODEL v5 图层域契约', () => {
  it('版本行登记 v5 与升版原因', () => {
    expect(productModel).toContain('版本：v5（2026-09-20，随 studio-layers ④段图层化')
  })

  it('对象树补图层域（layers/history/computeQueue/projectPersistence 四子模块）+ 项目行扩 layers[]', () => {
    const tree = sectionOf(productModel, '对象关系树')
    expect(tree).toContain('排钻设计 · 图层域')
    for (const sub of ['layers', 'history', 'computeQueue', 'projectPersistence']) {
      expect(tree).toContain(sub)
    }
    expect(tree).toContain('来源 + layers[] 图层化参数全集')
  })

  it('真源表：策略选择宿主迁移（旧宿主「胶片带」措辞清零）+ 图层行/观察态行在位', () => {
    const table = sectionOf(productModel, '单一真源表')
    expect(table).not.toContain('胶片带') // 旧宿主措辞清零（本节内）
    const strategyRow = table.split('\n').find((line) => line.startsWith('| 排钻策略选择 |'))
    expect(strategyRow).toContain('图层配置字段')
    expect(table).toContain('| 图层结构与配置 |')
    expect(table).toContain('| 观察态（层可见性/背景/选择/取景） |')
    expect(table).toContain('不入 .gemproj、不入历史')
  })

  it('硬规则补：隐藏层仍计算/统计/导出 + 多选批量 = 单 op', () => {
    const rules = sectionOf(productModel, '硬规则')
    expect(rules).toMatch(/9\. 隐藏层仍参与计算\/统计\/导出/)
    expect(rules).toMatch(/10\. 多选批量写层 = 单个 layer\.config op/)
  })
})
