/*
 * [2026-09-21 redesign-designer-workbench 4.3 Test] 隐藏层导出口径（design §4.4——R1-P0-2
 * 裁决，验收原文五条）：
 * ① 同一文档隐藏一层后，SVG/BOM/PNG 三导出均不含该层钻；
 * ② 状态栏仍显示总量 + 隐藏数（「N 钻 · 含 M 隐藏」——数据源 countHiddenGems 与投影同源）；
 * ③ 导出确认点「取消」= 零产物（无任何文件写出——createObjectURL/anchor click 零调用）；
 * ④ 可见钻集的 spacing / missing-asset 校验仍走同一 export gate（投影不豁免校验）；
 * ⑤ 直接调用 export API（绕过 UI 确认）也不能绕过可见层投影（裁剪在 service 投影面）。
 * 锁定≠隐藏：锁定层不参与过滤（可见即导出）随 ①/⑤ 断言。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import DesignerStatusBar from '../../components/Designer/DesignerStatusBar.svelte'
import {
  countHiddenGems,
  createDocumentService,
  editDocumentService,
  projectVisibleGems,
  type EditStoreSurface,
} from '$lib/services/documentService'
import {
  addGemLayer,
  applyPatch,
  getEditDoc,
  isEditDirty,
  loadFromHandoff,
  resetEditForTests,
  setGemLayerLocked,
  setGemLayerVisible,
} from '$lib/stores/edit.svelte'
import { buildGemdocExport, loadFromGemdoc, saveGemdoc, saveGemdocAs } from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { resetWorkbenchForTests } from '$lib/designer/workbench.svelte'
import { resetViewportForTests } from '$lib/designer/viewport.svelte'
import { fullBlock, installCodecStubEnv, makeHandoff } from '../edit/helpers'
import type { DesignerGem } from '$lib/stores/edit.svelte'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** 真实 edit store 直连面（投影/导出路径只读 getEditDoc——save/load 引用不触）。 */
function realStoreSurface(): EditStoreSurface {
  return {
    getEditDoc: getEditDoc,
    isEditDirty: isEditDirty,
    loadFromGemdoc: loadFromGemdoc,
    saveGemdoc: saveGemdoc,
    saveGemdocAs: saveGemdocAs,
    buildGemdocExport: buildGemdocExport,
  }
}

/** 标准两层文档：L1 = makeHandoff 12 钻（可见）；L2「隐藏层」= 2 颗手工钻（隐藏）。 */
function loadTwoLayerDoc(): void {
  loadFromHandoff(makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 }))
  addGemLayer('隐藏层')
  applyPatch({
    op: 'add',
    gems: [
      manualGem('m-h1', 40, 'L2'),
      manualGem('m-h2', 52, 'L2'),
    ],
  })
  setGemLayerVisible('L2', false)
}

function manualGem(id: string, x: number, layerId: string, extra: Partial<DesignerGem> = {}): DesignerGem {
  return {
    id,
    x,
    y: 40,
    colorId: 'red',
    blockId: null,
    origin: 'manual',
    moved: false,
    shapeId: 'round',
    diameterMm: 2.8,
    layerId,
    ...extra,
  }
}

function mountComponent<T extends typeof DesignerView | typeof DesignerStatusBar>(component: T): {
  target: HTMLElement
  unmount: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(component, { target })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetEditForTests()
  resetWorkbenchForTests()
  resetViewportForTests()
  resetToastsForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('projectVisibleGems 纯函数（投影语义：锁定≠隐藏；防御收敛）', () => {
  it('隐藏层过滤 / 锁定不过滤 / 未知归属不产出 / 空层文档空集', () => {
    loadTwoLayerDoc()
    setGemLayerLocked('L1', true) // L1 锁定但可见——锁定只约束编辑面，不参与导出过滤
    const doc = getEditDoc()!
    const visible = projectVisibleGems(doc)
    expect(visible).toHaveLength(12) // 仅 L2（隐藏）被裁
    expect(visible.every((g) => g.layerId === 'L1')).toBe(true)
    expect(countHiddenGems(doc)).toBe(2)

    // 未知归属（防御收敛——v3 序列化归属闭合保证内存面不出现）
    applyPatch({ op: 'add', gems: [manualGem('m-x', 64, 'LX-不存在')] })
    const d2 = getEditDoc()!
    expect(projectVisibleGems(d2).some((g) => g.id === 'm-x')).toBe(false)
    expect(countHiddenGems(d2)).toBe(3) // 无层可见性可依的归属计入隐藏口径（不产出）
  })
})

describe('验收 ①：同一文档隐藏一层后，SVG/BOM/PNG 三导出均不含该层钻', () => {
  it('SVG（圆钻快路径 circle 计数）/ BOM（合计行）/ PNG（renderer 收到的即投影集）', async () => {
    loadTwoLayerDoc()

    // SVG：L1 12 颗 round → 12 circle；L2 2 颗隐藏不进产物
    const svg = await editDocumentService.exportSvg()
    expect(svg.status).toBe('exported')
    if (svg.status !== 'exported') throw new Error('expected exported')
    expect((await svg.blob.text()).match(/<circle /g)).toHaveLength(12)

    // BOM：合计行 = 可见钻数
    const bom = await editDocumentService.exportBom()
    expect(bom.status).toBe('exported')
    if (bom.status !== 'exported') throw new Error('expected exported')
    const csv = await bom.blob.text()
    expect(csv).toContain('合计,,,,,12')

    // PNG：投影在 service 面——注入 renderer 收到的 doc.gems 即可见集
    const captured: DesignerGem[][] = []
    const svc = createDocumentService({
      store: realStoreSurface(),
      renderPng: async (d) => {
        captured.push(d.gems)
        return new Blob(['png-bytes'], { type: 'image/png' })
      },
    })
    const png = await svc.exportPng()
    expect(png.status).toBe('exported')
    expect(captured).toHaveLength(1)
    expect(captured[0]).toHaveLength(12)
    expect(captured[0].every((g) => g.layerId === 'L1')).toBe(true)

    // 对照：恢复 L2 可见 → 同一文档三导出含全部（过滤动态随层 visible）
    setGemLayerVisible('L2', true)
    const svgAll = await editDocumentService.exportSvg()
    if (svgAll.status !== 'exported') throw new Error('expected exported')
    expect((await svgAll.blob.text()).match(/<circle /g)).toHaveLength(14)
    const bomAll = await editDocumentService.exportBom()
    if (bomAll.status !== 'exported') throw new Error('expected exported')
    expect(await bomAll.blob.text()).toContain('合计,,,,,14')
  })

  it('锁定≠隐藏：锁定层（可见）三导出照常包含（锁定不参与投影过滤）', async () => {
    loadTwoLayerDoc()
    setGemLayerLocked('L1', true) // 可见 + 锁定
    const svg = await editDocumentService.exportSvg()
    if (svg.status !== 'exported') throw new Error('expected exported')
    expect((await svg.blob.text()).match(/<circle /g)).toHaveLength(12) // L1 全量在产物
  })
})

describe('验收 ②：状态栏仍显示总量 + 隐藏数（数据源 countHiddenGems）', () => {
  it('隐藏层存在：「14 钻 · 含 2 隐藏」；无隐藏层不显隐藏段', async () => {
    loadTwoLayerDoc()
    const view = mountComponent(DesignerStatusBar)
    await tick()
    const total = view.target.querySelector('[data-testid="designer-status-total"]')!
    expect(total.textContent).toContain('14 钻')
    expect(total.querySelector('[data-testid="designer-status-hidden"]')?.textContent).toContain('含 2 隐藏')

    setGemLayerVisible('L2', true)
    await tick()
    expect(view.target.querySelector('[data-testid="designer-status-total"]')!.textContent).toContain('14 钻')
    expect(view.target.querySelector('[data-testid="designer-status-hidden"]')).toBeNull()

    view.unmount()
  })
})

describe('验收 ③：导出确认点「取消」= 零产物（无任何文件写出）', () => {
  it('隐藏层存在时导出弹确认「不含 N 个隐藏层」；取消零下载；确认才产出', async () => {
    loadTwoLayerDoc()
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = mountComponent(DesignerView)
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-doc-menu-toggle"]')!.click()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-menu-export-svg"]')!.click()
    await tick()

    // 确认弹窗：显式裁剪文案（不含 N 个隐藏层 + N 颗钻）
    const confirmBtn = document.querySelector<HTMLButtonElement>('[data-testid="designer-export-confirm"]')
    expect(confirmBtn).not.toBeNull()
    expect(document.body.textContent).toContain('不含 1 个隐藏层')
    expect(document.body.textContent).toContain('2 颗钻')

    // 取消 = 零产物：无 blob 创建、无下载锚点
    document.querySelector<HTMLButtonElement>('[data-testid="designer-export-confirm-cancel"]')!.click()
    await tick()
    expect(urlSpy).not.toHaveBeenCalled()
    expect(clickSpy).not.toHaveBeenCalled()

    // 再导出并确认 → 产物产出（12 钻可见集——投影在 service 恒生效）
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-doc-menu-toggle"]')!.click()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-menu-export-svg"]')!.click()
    await tick()
    document.querySelector<HTMLButtonElement>('[data-testid="designer-export-confirm"]')!.click()
    await tick()
    await tick()
    expect(urlSpy).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)

    view.unmount()
  })

  it('无隐藏层导出不弹确认（直达产物）', async () => {
    loadFromHandoff(makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 }))
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = mountComponent(DesignerView)
    await tick()

    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-doc-menu-toggle"]')!.click()
    await tick()
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-menu-export-bom"]')!.click()
    await tick()
    await tick()
    expect(document.querySelector('[data-testid="designer-export-confirm"]')).toBeNull() // 无确认门
    expect(urlSpy).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)

    view.unmount()
  })
})

describe('验收 ④：可见钻集 spacing / missing-asset 校验仍走同一 export gate（投影不豁免校验）', () => {
  it('可见集 spacing 违规 → blocked（违规明细含可见钻对）；违规只在隐藏层 → 不阻断', async () => {
    loadTwoLayerDoc()
    // 可见集制造间距冲突：L1 行钻 g00001 (4,4) 与 g00002 (12,4) → 改 g00002.x=6（中心距 2 < 判距）
    applyPatch({ op: 'update', changes: [{ id: 'g00002', before: { x: 12 }, after: { x: 6 } }] })
    const blocked = await editDocumentService.exportSvg()
    expect(blocked.status).toBe('blocked')
    if (blocked.status !== 'blocked') throw new Error('expected blocked')
    expect(blocked.violations.some((v) => v.kind === 'spacing' && v.gemIds.includes('g00001'))).toBe(true)

    // 对照：违规只在隐藏层（L2 两钻重叠）→ 投影后无违规对，放行
    resetEditForTests()
    loadFromHandoff(makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 }))
    addGemLayer('隐藏层')
    applyPatch({
      op: 'add',
      gems: [
        manualGem('m-h1', 40, 'L2'),
        manualGem('m-h2', 41, 'L2'), // 同位重叠——但层隐藏，不进 gate
      ],
    })
    setGemLayerVisible('L2', false)
    const passed = await editDocumentService.exportSvg()
    expect(passed.status).toBe('exported')
  })

  it('missing-asset：可见层 custom 无 assetId → blocked（typed invalid）；隐藏层同钻 → 放行', async () => {
    // 可见层 custom 无 assetId（engine 门无条件 typed invalid——投影不豁免校验）
    loadFromHandoff(makeHandoff(12, { blocks: [fullBlock(96, 64)], width: 96 }))
    addGemLayer('隐藏层') // L2
    applyPatch({
      op: 'add',
      gems: [manualGem('m-c1', 40, 'L1', { shapeId: 'custom' as never, diameterMm: 3 })],
    })
    const blocked = await editDocumentService.exportSvg()
    expect(blocked.status).toBe('blocked')
    if (blocked.status !== 'blocked') throw new Error('expected blocked')
    expect(blocked.violations.some((v) => v.kind === 'missing-asset' && v.gemIds.includes('m-c1'))).toBe(true)

    // 同钻移入隐藏层（单 op）→ 投影排除 → 放行（可见集无 custom 引用）
    applyPatch({ op: 'update', changes: [{ id: 'm-c1', before: { layerId: 'L1' }, after: { layerId: 'L2' } }] })
    setGemLayerVisible('L2', false)
    const passed = await editDocumentService.exportSvg()
    expect(passed.status).toBe('exported')
  })
})

describe('验收 ⑤：直接调用 export API（绕过 UI 确认）也不能绕过可见层投影', () => {
  it('无 UI 直调默认实例：SVG/BOM 均为可见集（裁剪在 service 投影面，非 UI 过滤）', async () => {
    const restoreCodec = installCodecStubEnv() // gemdoc 序列化 canvas 编解码桩（jsdom）
    try {
      loadTwoLayerDoc()
      const svg = await editDocumentService.exportSvg()
      if (svg.status !== 'exported') throw new Error('expected exported')
      expect((await svg.blob.text()).match(/<circle /g)).toHaveLength(12)

      const bom = await editDocumentService.exportBom()
      if (bom.status !== 'exported') throw new Error('expected exported')
      expect(await bom.blob.text()).toContain('合计,,,,,12')

      // gemdoc 导出（文档本体）不投影——分层口径：产物导出裁剪、文档序列化保全量
      const gemdoc = await editDocumentService.exportGemdoc()
      if (gemdoc.status !== 'exported') throw new Error(`expected exported, got ${JSON.stringify(gemdoc)}`)
      expect(getEditDoc()!.gems).toHaveLength(14) // 文档真源未被投影触碰（非破坏性投影）
    } finally {
      restoreCodec()
    }
  })
})
