/*
 * [2026-09-21 redesign-designer-workbench 7.2 Test → rework-designer-manual-rhinestone R1]
 * 智能排布内核（design §5.3；quickLayout 钻数组产物模式的落点面）——UI 入口（DocBar 按钮/
 * 右键菜单项/命令 open-smart-layout/SmartLayoutPanel）已随 R1 退役（Owner 2026-09-21 裁决：
 * 智能排布应基于选区=路径编辑，归预留 change add-designer-selection-paths），内核冻结保留：
 * - 可用性单源 smartLayoutUnderlayReady（painting/reference 底图源判定；空白起步禁用）。
 * - filterSmartLayoutGems 冲突过滤决策核（pairwise requiredCenterDistancePx×0.999 同 brush
 *   拒画判据：既有钻冲突丢弃 / 批内冲突丢弃 / m- id 重写 + 目标层归属）。
 * - runSmartLayout 全链（underlay painting PNG 编码兜底 → 计算内核复用 → 过滤 → 落当前层
 *   单 undo 组；结果显式报数；产物过 spacing 硬门）。
 *
 * 环境声明：installCodecStubEnv（edit/helpers——paintingToDataUrl 编码 + Image 解码回读的
 * 像素级桩）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addGemLayer,
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  undo,
  type DesignerGem,
} from '$lib/stores/edit.svelte'
import { validateEditable } from '$lib/engine'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests, setCurrentLayerId } from '$lib/designer/workbench.svelte'
import { resetInteractionForTests } from '$lib/designer/interaction.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { resetViewStateForTests } from '$lib/designer/viewState.svelte'
import { setSpecCatalogForTests } from '$lib/designer/specSelector.svelte'
import { createInMemoryGemCatalogService } from '$lib/services/gemCatalogService'
import {
  filterSmartLayoutGems,
  resetSmartLayoutForTests,
  runSmartLayout,
  smartLayoutUnderlayReady,
} from '$lib/designer/smartLayout.svelte'
import { createBlankDocument } from '$lib/designer/entry'
import { installCodecStubEnv, makeHandoff } from '../edit/helpers'

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetInteractionForTests()
  resetViewportForTests()
  resetViewStateForTests()
  resetSmartLayoutForTests()
  resetToastsForTests()
  setSpecCatalogForTests(createInMemoryGemCatalogService())
})

afterEach(() => {
  setSpecCatalogForTests(null)
})

// ---------------------------------------------------------------------------
// 可用性单源（design §5.3：无参考底图禁用——underlay.sources 判据）
// ---------------------------------------------------------------------------

describe('smartLayoutUnderlayReady（无参考底图禁用单源）', () => {
  it('送精修形态（painting 源）可用；空白起步（零源）禁用；reference 源可用', () => {
    loadFromHandoff(makeHandoff(2))
    expect(smartLayoutUnderlayReady(getEditDoc())).toBe(true)

    createBlankDocument()
    expect(smartLayoutUnderlayReady(getEditDoc())).toBe(false)

    loadFromHandoff(makeHandoff(0, { referenceAssetId: 'ast-ref-1' }))
    expect(smartLayoutUnderlayReady(getEditDoc())).toBe(true)

    expect(smartLayoutUnderlayReady(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 冲突过滤决策核（design §5.3：与既有钻间距冲突的结果钻丢弃——显式计数）
// ---------------------------------------------------------------------------

describe('filterSmartLayoutGems（pairwise 冲突过滤纯函数）', () => {
  const grid = { pitchMm: 3.2, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 } as const
  // 等径 2.8mm 判距：((2.8+2.8)/2 + 0.4)mm × 2.5 = 8px（×0.999 = 7.992）
  const existing: DesignerGem[] = [
    { id: 'g00001', x: 10, y: 10, layerId: 'L1', colorId: 'red', blockId: null, origin: 'layout', moved: false, shapeId: 'round', diameterMm: 2.8 },
  ]

  function candidate(x: number, y: number) {
    return {
      id: 'g00009',
      x,
      y,
      colorId: 'red',
      blockId: null,
      origin: 'manual' as const,
      moved: false,
      shapeId: 'round' as const,
      diameterMm: 2.8,
    }
  }

  it('距离 < 判距 → 丢弃；≥ 判距（含恰等 pitch 的容差内）→ 保留；保留钻 m- id 重写 + 归目标层', () => {
    const { kept, dropped } = filterSmartLayoutGems(existing, [candidate(14, 10), candidate(18, 10)], grid, 'L2')
    expect(dropped).toBe(1) // 距离 4px < 7.992px
    expect(kept).toHaveLength(1) // 距离 8px ≥ 7.992px（×0.999 容差）
    expect(kept[0].id).toMatch(/^m-\d+$/) // engine layout g##### 命名空间重写为编辑器手工钻段
    expect(kept[0].layerId).toBe('L2')
  })

  it('批内冲突同判（先保留者占位，后到冲突候选丢弃）', () => {
    const { kept, dropped } = filterSmartLayoutGems([], [candidate(10, 10), candidate(12, 10), candidate(30, 30)], grid, 'L1')
    expect(kept).toHaveLength(2)
    expect(dropped).toBe(1) // 第二颗距第一颗 2px < 7.992px
  })
})

// ---------------------------------------------------------------------------
// runSmartLayout 全链（落当前层单 undo 组 + 报数 + spacing 硬门）
// ---------------------------------------------------------------------------

describe('runSmartLayout 全链（painting 底图 → 计算内核 → 过滤 → 落当前层）', () => {
  let restoreEnv: (() => void) | null = null
  beforeEach(() => {
    restoreEnv = installCodecStubEnv() // paintingToDataUrl 编码 + 解码回读（像素级桩）
  })
  afterEach(() => {
    restoreEnv?.()
    restoreEnv = null
  })

  it('结果落当前层（显式 L2）、单 undo 组整体撤销、m- id、冲突显式报数、产物过 spacing 硬门', async () => {
    loadFromHandoff(makeHandoff(2)) // painting 底图源 + g00001(4,4)/g00002(12,4) 在 L1
    const l2 = addGemLayer('排布层')!
    setCurrentLayerId('L2', getEditDoc())
    const before = getUndoDepths().undo

    const result = await runSmartLayout({
      strategy: 'hybrid',
      spec: { shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
      gapMm: 0.4,
      density: 1,
    })

    const doc = getEditDoc()!
    expect(result.added).toBe(doc.gems.length - 2)
    expect(result.added).toBeGreaterThan(0)
    expect(result.sourceSummary).toContain('语义混合')
    // 落当前层 + 新增 manual 钻语义（m- id；既有 L1 归属不动）
    for (const gem of doc.gems.filter((g) => g.id.startsWith('m-'))) {
      expect(gem.layerId).toBe(l2)
      expect(gem.origin).toBe('manual')
      expect(gem.blockId).toBeNull()
      expect(gem.shapeId).toBe('round')
      expect(gem.diameterMm).toBe(2.8)
    }
    expect(doc.gems.filter((g) => g.layerId === 'L1')).toHaveLength(2)
    // 产物过 pairwise spacing 硬门（冲突过滤的验收面——validateEditable 无 spacing 违规）
    const spacing = validateEditable(doc.gems, doc.grid, doc.blocks).filter((w) => w.kind === 'spacing')
    expect(spacing).toHaveLength(0)
    // 单 undo 组：一次撤销整体恢复（含冲突丢弃语义——dropped 不产生部分并入）
    expect(getUndoDepths().undo).toBe(before + 1)
    undo()
    expect(getEditDoc()!.gems).toHaveLength(2)
    expect(getEditDoc()!.gems.every((g) => g.layerId === 'L1')).toBe(true)
  })

  it('无底图显式失败（空白起步）；文档缺席显式失败', async () => {
    createBlankDocument()
    await expect(
      runSmartLayout({ strategy: 'hybrid', spec: { shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }, gapMm: 0.4, density: 1 }),
    ).rejects.toThrow('需要参考底图')

    resetEditForTests()
    await expect(
      runSmartLayout({ strategy: 'hybrid', spec: { shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }, gapMm: 0.4, density: 1 }),
    ).rejects.toThrow('编辑文档未载入')
  })
})
