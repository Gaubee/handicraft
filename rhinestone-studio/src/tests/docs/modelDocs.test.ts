/*
 * [studio-layers 3.1 → redesign-designer-workbench R0 0.2] 术语表/产品模型文档契约
 * （TERMS v5 + PRODUCT_MODEL v6 两台更名升版的 CI grep 核对；v3/v4/v5 历史链断言保留）：
 * - 版本登记在位（TERMS v5 / PM v6 头注含升版原因）；
 * - [R0 v5] 三组更名注册：设计师工作台（Owner 定调定位句）/ 排钻工作台 / 智能排布
 *   + 退役词映射三链条断言（断言内引旧词——禁用词注册面本身的合法引用）+ 新词条
 *   参考底层/钻石层 + 隐藏层导出分模块口径入词条；
 * - [R0 v6] PM 两台分工边界表 + 硬规则 6 修订（不以参数为工作方式；显式工具允许参数小窗）+
 *   硬规则 9 分模块口径（排钻=隐藏仍导出；设计师=隐藏不导出+导出前显式提示）；
 * - [v5 图层化] studio-layers 既有断言随措辞联动更新（对象树「排钻工作台 · 图层域」）。
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

describe('TERMS 版本头注契约（v5 两台更名 → v4 原图改名 → v3 图层化链）', () => {
  it('版本头注登记最新版与升版原因（v5 redesign R0 + v4/v3 历史链均在位）', () => {
    // [redesign R0 v5] 三组更名 + 收口 improve-paving 遗留窗口
    expect(terms).toContain('状态：v5（2026-09-20，随 redesign-designer-workbench R0')
    expect(terms).toContain('「专家工作台」→「设计师工作台」')
    expect(terms).toContain('「排钻设计」→「排钻工作台」')
    expect(terms).toContain('「快速排稿」→「智能排布」')
    // [placeholders v4] 历史链保留（版本注记）
    expect(terms).toContain('v4（2026-09-20，随 add-lab-effect-prompt-placeholders')
    expect(terms).toContain('参考图/参考原图 → 原图（v4）')
    // v3 图层化升版链保留（历史版本注记）
    expect(terms).toContain('随 studio-layers ④段图层化')
    expect(terms).toContain('两个「物理」不得混用')
  })

  it('[R0 v5] 退役词映射三链条（含移动端短名更替）', () => {
    expect(terms).toContain('转化工作台 → 排钻设计 → 排钻工作台')
    expect(terms).toContain('手动编辑 → 专家工作台 → 设计师工作台（移动端：专家 → 设计）')
    expect(terms).toContain('快速排稿 → 智能排布（v5）')
  })

  it('[R0 v5] 两台模块词条 + 移动端短名（定位句 = Owner 定调）', () => {
    expect(terms).toMatch(/\| 排钻工作台 \|[^|]*图层 \+ 算法批量排钻/)
    expect(terms).toMatch(/\| 排钻 \|[^|]*排钻工作台 的移动端短名/)
    expect(terms).toMatch(/\| 设计师工作台 \|[^|]*逐钻微调的设计台/)
    expect(terms).toMatch(/能对每一颗钻进行微调/) // Owner 定调原句入词条
    expect(terms).toMatch(/\| 设计 \|[^|]*设计师工作台 的移动端短名/)
    expect(terms).toContain('专家工作台、手动编辑、精修编辑器') // 旧名只存于禁用词列
  })

  it('[R0 v5] 智能排布 / 参考底层 / 钻石层词条注册 + 隐藏层分模块口径入词条', () => {
    expect(terms).toMatch(/\| 智能排布 \|[^|]*显式排钻算法工具/)
    expect(terms).toMatch(/\| 参考底层 \|[^|]*钉底特殊层/)
    expect(terms).toMatch(/\| 钻石层 \|[^|]*内容组织层/)
    expect(terms).toMatch(/\| 设计师工作台 \|[^|]*隐藏层不导出、导出前显式提示/)
  })

  it('[placeholders v4] 原图词条改名 + 案例参照图功能开关语义', () => {
    expect(terms).toMatch(/\| 原图 \|[^|]*用户要处理的目标图/)
    expect(terms).toContain('参考图、参考原图、底图')
    expect(terms).toMatch(/\| 案例参照图 \|[^|]*功能性开关效果/)
  })

  it('图层化词条注册：图层/背景层/历史/观察态（含禁用词列；v5 措辞联动排钻工作台）', () => {
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

describe('PRODUCT_MODEL v6 契约（R0 两台更名 + 分工边界 + 硬规则 6/9 修订）', () => {
  it('版本行登记 v6 与升版原因（v5/v4 历史链保留）', () => {
    expect(productModel).toContain('版本：v6（2026-09-20，随 redesign-designer-workbench R0')
    expect(productModel).toContain('v5（2026-09-20，随 studio-layers ④段图层化')
  })

  it('对象树补图层域（layers/history/computeQueue/projectPersistence 四子模块；v6 措辞联动）', () => {
    const tree = sectionOf(productModel, '对象关系树')
    expect(tree).toContain('排钻工作台 · 图层域')
    for (const sub of ['layers', 'history', 'computeQueue', 'projectPersistence']) {
      expect(tree).toContain(sub)
    }
    expect(tree).toContain('来源 + layers[] 图层化参数全集')
    expect(tree).toContain('设计师工作台 · 项目（.gemdoc）')
  })

  it('[R0 v6] 两台分工边界表：心智/真源/图层语义/隐藏层口径/送精修通道', () => {
    const boundary = sectionOf(productModel, '两台分工边界')
    expect(boundary).toContain('| 排钻工作台 |')
    expect(boundary).toContain('| 设计师工作台 |')
    expect(boundary).toContain('逐钻自由微调')
    expect(boundary).toContain('显式工具')
    expect(boundary).toContain('隐藏层不导出')
    expect(boundary).toContain('送精修通道不变')
    expect(boundary).toContain('不回流排钻管线')
  })

  it('真源表：策略选择宿主迁移（旧宿主「胶片带」措辞清零）+ 图层行/观察态行/智能排布参数行在位', () => {
    const table = sectionOf(productModel, '单一真源表')
    expect(table).not.toContain('胶片带') // 旧宿主措辞清零（本节内）
    const strategyRow = table.split('\n').find((line) => line.startsWith('| 排钻策略选择 |'))
    expect(strategyRow).toContain('图层配置字段')
    expect(table).toContain('| 图层结构与配置 |')
    expect(table).toContain('| 观察态（层可见性/背景/选择/取景） |')
    expect(table).toContain('不入 .gemproj、不入历史')
    expect(table).toContain('| 智能排布参数 |')
  })

  it('[R0 v6] 硬规则 6 修订 + 硬规则 9 分模块口径（+ 既有规则 10 保持）', () => {
    const rules = sectionOf(productModel, '硬规则')
    expect(rules).toMatch(/6\. 设计师工作台不以排钻参数为工作方式/)
    expect(rules).toContain('「智能排布」允许其自有的参数小窗')
    expect(rules).toMatch(/9\. 隐藏层导出分模块口径/)
    expect(rules).toMatch(/排钻工作台隐藏层仍参与计算\/统计\/导出/)
    expect(rules).toMatch(/设计师工作台隐藏层不导出、导出前显式提示/)
    expect(rules).toMatch(/10\. 多选批量写层 = 单个 layer\.config op/)
  })
})
