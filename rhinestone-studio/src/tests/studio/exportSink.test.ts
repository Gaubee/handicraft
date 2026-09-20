/*
 * [2026-09-20 studio-layers 2.9 · E.6 矩阵行 5/8 核销] 导出双 Sink 全层接线 + 文件名去策略后缀：
 * - buildActiveSvg / buildActiveBom 消费 joint active result（全层 concat + 逐钻 spec）——双层层集下
 *   BOM 聚合键 canonical specKey×colorId 色维分行（层级颜色覆写 → 同规格不同色分行）且合计 = Σ 层钻数
 *   （混合规格分行面归 ③段 handoffV2/jointGate：逐钻 GemSpecSnapshot 物化后 BOM 规格列即分层规格）；
 * - 隐藏层照常导出（隐藏 ≠ 排除——工作默认一观察态边界）：隐藏一方合计不变；
 * - exportFileName = `${baseName}.${ext}`（去 `-${activeStrategy}` 后缀——层模型无单一主策略）；
 * - 门前置：无结果（空会话）→ 双 Sink null（违规阻断语义的门前置面归 jointGate.test +
 *   studio.interactions 导出四路硬断）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildActiveBom,
  buildActiveSvg,
  dispatchLayerConfigOp,
  dispatchStudioOp,
  exportFileName,
  getActiveResult,
  getBlocks,
  getExportCheck,
  getLayers,
  getPalette,
  loadFromEngineImage,
  resetStudioForTests,
  setBlockColor,
  setLayerVisible,
  waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
})

async function loadSession(): Promise<void> {
  loadFromEngineImage(fixtureShapes(), '导出图.png', 'upload')
  await waitForStudioIdle()
}

/** BOM 合计行钻数。 */
async function bomTotal(): Promise<number> {
  const blob = buildActiveBom()
  if (blob === null) throw new Error('BOM 不可用（门未就绪）')
  const csv = await blob.text()
  return Number(/合计,,,,,(\d+)/.exec(csv)?.[1] ?? NaN)
}

describe('E.6-5 buildActiveSvg/Bom 全层接线（多层 concat + 逐钻 spec + exportGate 前置）', () => {
  it('双层层集：BOM 聚合键 specKey×colorId 色维分行 + 合计 = Σ 层；SVG 圆钻节点在场', async () => {
    await loadSession()
    // 最小面积块（4×4 蓝孤点）入 L2：同规格同 gap → 跨层 pairwise 需求与单层一致 → 联合门合规
    const smallest = getBlocks().reduce((min, b) => (b.areaPx < min.areaPx ? b : min))
    dispatchStudioOp({ t: 'layer.create', name: '孤点层', blockIds: [smallest.id] })
    await waitForStudioIdle()
    expect(getLayers()).toHaveLength(2)
    const check = getExportCheck()
    expect(check.ready).toBe(true)
    expect(check.exportable).toBe(true) // 跨层间距门通过

    // 层级颜色覆写（L2 块钉另一色板色——不动几何）→ 同规格不同色 → BOM 分行
    const overrideColor = getPalette().find((c) => c.id !== 'c1')!
    setBlockColor(smallest.id, overrideColor.id)
    await waitForStudioIdle()

    const total = getActiveResult()!.gems.length
    expect(total).toBeGreaterThan(0)
    expect(await bomTotal()).toBe(total) // 合计 = 全层 concat（joint 口径）

    const csv = await buildActiveBom()!.text()
    expect(csv).toContain('round-ss10') // 规格列（canonical specKey）
    const specRows = csv.split('\r\n').filter((line) => line.startsWith('round-ss10,'))
    expect(specRows.length).toBeGreaterThanOrEqual(2) // 同规格 × 不同色 → 分行（聚合键证明）
    expect(csv).toContain(overrideColor.name) // 覆写色行在场

    const svg = await buildActiveSvg()!.text()
    expect(svg).toContain('<circle') // 圆钻节点在场（方形/自定义渲染归 engine 目录面）
    expect(svg.length).toBeGreaterThan(1000)
  })

  it('隐藏层照常导出（隐藏 ≠ 排除）：隐藏一方后合计不变', async () => {
    await loadSession()
    const smallest = getBlocks().reduce((min, b) => (b.areaPx < min.areaPx ? b : min))
    dispatchStudioOp({ t: 'layer.create', name: 'L2', blockIds: [smallest.id] })
    await waitForStudioIdle()
    const before = await bomTotal()
    setLayerVisible('L2', false) // 观察态——不入导出口径
    expect(await bomTotal()).toBe(before)
  })

  it('门前置：空会话（无结果）→ 双 Sink null', () => {
    expect(buildActiveSvg()).toBeNull()
    expect(buildActiveBom()).toBeNull()
  })
})

describe('E.6-8 exportFileName 去 activeStrategy 后缀', () => {
  it('`${baseName}.${ext}`——无策略后缀（层模型无单一主策略，层/策略信息归导出摘要）', async () => {
    await loadSession()
    dispatchLayerConfigOp(['L1'], { strategy: 'cvt' }) // 非默认策略下文件名仍无后缀
    expect(exportFileName('svg')).toBe('导出图.svg')
    expect(exportFileName('csv')).toBe('导出图.csv')
    expect(exportFileName('png')).toBe('导出图.png')
    expect(exportFileName('svg')).not.toMatch(/-(cvt|hybrid|hex-thin|hex-pitch|poisson)/)
  })
})
