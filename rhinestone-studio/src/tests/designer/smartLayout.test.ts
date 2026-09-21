/*
 * [2026-09-21 redesign-designer-workbench 7.2 Test] 智能排布工具（design §5.3；quickLayout
 * 钻数组产物模式的落点面）：
 * - 可用性单源 smartLayoutUnderlayReady（painting/reference 底图源判定；空白起步禁用）。
 * - filterSmartLayoutGems 冲突过滤决策核（pairwise requiredCenterDistancePx×0.999 同 brush
 *   拒画判据：既有钻冲突丢弃 / 批内冲突丢弃 / m- id 重写 + 目标层归属）。
 * - runSmartLayout 全链（underlay painting PNG 编码兜底 → 计算内核复用 → 过滤 → 落当前层
 *   单 undo 组；结果显式报数；产物过 spacing 硬门）。
 * - SmartLayoutPanel 参数小窗（策略×规格×gap×密度四参 + 进度取消 + 结果行报数）与 DocBar
 *   按钮禁用态/开合同源。
 *
 * 环境声明：installCodecStubEnv（edit/helpers——paintingToDataUrl 编码 + Image 解码回读的
 * 像素级桩）+ 目录注入 createInMemoryGemCatalogService（参数小窗规格档数据面）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import DesignerSmartLayoutPanel from '../../components/Designer/DesignerSmartLayoutPanel.svelte'
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
  getSmartLayoutOpen,
  resetSmartLayoutForTests,
  runSmartLayout,
  smartLayoutUnderlayReady,
} from '$lib/designer/smartLayout.svelte'
import { createBlankDocument } from '$lib/designer/entry'
import { execDesignerCommand } from '$lib/designer/commands'
import { installCodecStubEnv, makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

function mountView(): {
  target: HTMLElement
  q: (testid: string) => Element | null
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    q: (testid: string) => document.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

/** 直挂参数小窗（执行链测试——不挂全视图：codec 桩与 DesignerCanvas 的 ImageData 面互斥）。 */
function mountPanel(): {
  q: (testid: string) => Element | null
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerSmartLayoutPanel, { target })
  return {
    q: (testid: string) => document.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

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

// ---------------------------------------------------------------------------
// SmartLayoutPanel 参数小窗 + DocBar 按钮（design §5.3 入口/参数/进度/结果行）
// ---------------------------------------------------------------------------

describe('SmartLayoutPanel + DocBar 入口（视图装配）', () => {
  beforeEach(() => {
    loadFromHandoff(makeHandoff(2)) // painting 底图源文档（DocBar 按钮可用态）
  })

  it('DocBar「智能排布…」按钮：painting 底图可用 → 点击经命令总线开参数小窗（四参 + 开始排布）', async () => {
    const view = mountView()
    await tick()
    const button = view.q('designer-smart-layout') as HTMLButtonElement
    expect(button.disabled).toBe(false)

    button.click()
    await tick()
    expect(getSmartLayoutOpen()).toBe(true)
    const panel = view.q('designer-smart-layout-panel')
    expect(panel).not.toBeNull()
    // 参数小窗四参齐备（策略/基础规格/间距/密度——PRODUCT_MODEL v6 硬规则 6 修订口径）
    expect(view.q('designer-smart-strategy')).not.toBeNull()
    expect(view.q('designer-smart-spec')).not.toBeNull()
    expect(view.q('designer-smart-gap')).not.toBeNull()
    expect(view.q('designer-smart-density')).not.toBeNull()
    expect(view.q('designer-smart-run')).not.toBeNull()

    view.unmount()
  })

  it('空白起步文档：DocBar 按钮禁用 + tooltip「需要参考底图」（命令门槛同判据）', async () => {
    const view = mountView()
    await tick()
    createBlankDocument()
    await tick()
    const button = view.q('designer-smart-layout') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('需要参考底图')
    expect(execDesignerCommand({ kind: 'open-smart-layout' })).toBe(false)

    view.unmount()
  })

  it('执行：开始排布 → 结果行显式报数（并入 N 颗，跳过 M 颗冲突）+ 单 undo 组撤销', async () => {
    const restoreEnv = installCodecStubEnv() // 直挂面板（不挂全视图——桩与 Canvas ImageData 面互斥）
    try {
      const before = getUndoDepths().undo
      expect(execDesignerCommand({ kind: 'open-smart-layout' })).toBe(true)
      await tick()
      const panel = mountPanel()
      await tick()
      expect(panel.q('designer-smart-layout-panel')).not.toBeNull()

      // 规格选 round-ss10（与底图 pitch 8px 网格同参——冲突面确定性）
      const spec = panel.q('designer-smart-spec') as HTMLSelectElement
      spec.value = 'round-ss10'
      spec.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()

      ;(panel.q('designer-smart-run') as HTMLElement).click()
      await vi.waitFor(
        () => {
          expect(panel.q('designer-smart-result')).not.toBeNull()
        },
        { timeout: 3000 },
      )
      const text = (panel.q('designer-smart-result') as HTMLElement).textContent ?? ''
      expect(text).toMatch(/^并入 \d+ 颗，跳过 \d+ 颗冲突$/)
      // 结果行第二行 = 来源摘要（策略·密度·规格·计数——quickLayout 单源）
      expect((panel.q('designer-smart-result-summary') as HTMLElement).textContent).toContain('语义混合')

      const doc = getEditDoc()!
      const added = doc.gems.filter((g) => g.id.startsWith('m-')).length
      expect(added).toBeGreaterThan(0)
      expect(getUndoDepths().undo).toBe(before + 1) // 单 undo 组
      ;(panel.q('designer-smart-close') as HTMLElement).click()
      await tick()
      expect(getSmartLayoutOpen()).toBe(false)

      undo()
      expect(getEditDoc()!.gems).toHaveLength(2) // 一次撤销整体恢复（makeHandoff(2) 基线）
      panel.unmount()
    } finally {
      restoreEnv()
    }
  })
})
