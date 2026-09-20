/*
 * [2026-09-21 redesign-designer-workbench 3.2 Test] 规格选择器 + 当前规格跟随（tasks 3.2）：
 * - 纯函数面：specCodeOf 规格码人读 / groupSpecCatalog 目录分组 / buildSpecChanges 批量改规格
 *   四键对称（custom⇄builtin 双向 assetId 同改；全等钻不入；非法规格守卫）/ pushRecentSpec
 *   去重与上限。
 * - 命令总线 apply-spec（design §6.2 唯一写入口）：空选 = 写 brushSpec 真源；选中钻 =
 *   批量改规格**单 undo 组**（undo 逐字段恢复含 assetId）；非法规格拒绝零写入；custom 形
 *   prefetch 资产解析；open-spec-selector 经 UI 钩子（delete-selection 同源模式）。
 * - hexSnap 吸附随规格 pitch 重算（design §6.1）：brushSnapPitchPx 基准派生态与 pitchPx(grid)
 *   逐位相等；覆盖态换 pitch；画布落点吸附消费单源（jsdom 指针序列）。
 * - 组件面（DesignerView 全链）：规格选择器弹层（目录 gemCatalogService 注入消费）/ 档位
 *   应用到选中钻 / 右键「改规格▸」子树（最近使用 + 「更多…」打开规格选择器）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import DesignerView from '../../components/Designer/DesignerView.svelte'
import {
  getEditDoc,
  getUndoDepths,
  loadFromHandoff,
  resetEditForTests,
  setSelection,
  undo,
} from '$lib/stores/edit.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  BrushSpecShapeError,
  emitBrushEvent,
  getBrushSpec,
  onBrushStroke,
  resetWorkbenchForTests,
  setBrushSpec,
  type BrushSpecState,
} from '$lib/designer/workbench.svelte'
import {
  attachBrushEngine,
  brushAssetStatusOf,
  brushSnapPitchPx,
  resolveBrushAsset,
  setBrushCatalogForTests,
} from '$lib/designer/brushEngine'
import {
  execDesignerCommand,
  installDesignerUiHooks,
  type DesignerUiHooks,
} from '$lib/designer/commands'
import {
  buildSpecChanges,
  getRecentSpecs,
  getSpecCatalog,
  getSpecSelectorOpen,
  groupSpecCatalog,
  loadSpecCatalog,
  MAX_RECENT_SPECS,
  pushRecentSpec,
  resetSpecSelectorForTests,
  setSpecCatalogForTests,
  setSpecSelectorOpen,
  specCodeOf,
  type RecentSpec,
} from '$lib/designer/specSelector.svelte'
import { customSpecKey, pitchPx } from '$lib/engine'
import type { CatalogSpec, GemCatalogService } from '$lib/services/gemCatalogService'
import { hexSnapPoint } from '$lib/designer/hexSnap'
import { computeFit } from '../../components/Studio/fit'
import { TEST_PITCH, makeHandoff } from '../edit/helpers'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const FIT = computeFit(600, 420, 64, 64)

function clientOf(imgX: number, imgY: number): { clientX: number; clientY: number } {
  return { clientX: FIT.x + imgX * FIT.scale, clientY: FIT.y + imgY * FIT.scale }
}

function pointer(el: Element, type: string, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: c.clientX,
      clientY: c.clientY,
    }),
  )
}

function contextmenu(el: Element, at: { x: number; y: number }): void {
  const c = clientOf(at.x, at.y)
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY, button: 2 }),
  )
}

function mountView(): { target: HTMLElement; canvas: () => HTMLCanvasElement | null; q: (testid: string) => Element | null; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DesignerView, { target })
  return {
    target,
    canvas: () => target.querySelector<HTMLCanvasElement>('[data-testid="designer-canvas-canvas"]'),
    q: (testid: string) => document.querySelector(`[data-testid="${testid}"]`),
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await tick()
}

// ---------------------------------------------------------------------------
// 目录夹具（gemCatalogService 接口零改动消费——注入替身）
// ---------------------------------------------------------------------------

const CATALOG: CatalogSpec[] = [
  { specKey: 'round-ss10', shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
  { specKey: 'round-ss16', shapeId: 'round', sizeLabel: 'SS16', diameterMm: 4 },
  { specKey: 'square-3.5', shapeId: 'square', sizeLabel: '3.5mm', diameterMm: 3.5 },
  { specKey: 'drop-4.3', shapeId: 'drop', sizeLabel: '4.3mm', diameterMm: 4.3 },
  {
    specKey: customSpecKey('ast-c1'),
    shapeId: 'custom',
    sizeLabel: '星芒 5mm',
    diameterMm: 5,
    widthMm: 5,
    heightMm: 3,
    assetId: 'ast-c1',
  },
]

function fakeCatalogService(): GemCatalogService {
  return {
    async listSpecs() {
      return CATALOG.map((e) => ({ ...e }))
    },
    async resolveSpec(specKey: string) {
      const found = CATALOG.find((e) => e.specKey === specKey)
      return found === undefined ? undefined : { ...found }
    },
  }
}

function gem(id: string) {
  return getEditDoc()!.gems.find((g) => g.id === id)!
}

beforeEach(() => {
  resetEditForTests()
  resetWorkbenchForTests()
  resetSpecSelectorForTests()
  resetToastsForTests()
  loadFromHandoff(makeHandoff(12))
})

afterEach(() => {
  installDesignerUiHooks(null)
  setSpecCatalogForTests(null)
  setBrushCatalogForTests(null)
})

// ---------------------------------------------------------------------------
// 纯函数面
// ---------------------------------------------------------------------------

describe('specCodeOf 规格码人读（design §6.2 R10/SQ35 形态）', () => {
  it('内置形 = 短码 + 尺寸 token；custom = 资产名透传', () => {
    expect(specCodeOf({ shapeId: 'round', sizeLabel: 'SS10' })).toBe('R10')
    expect(specCodeOf({ shapeId: 'square', sizeLabel: '3.5mm' })).toBe('SQ35')
    expect(specCodeOf({ shapeId: 'drop', sizeLabel: '4.3mm' })).toBe('DP43')
    expect(specCodeOf({ shapeId: 'custom', sizeLabel: '星芒 5mm' })).toBe('星芒 5mm')
  })
})

describe('groupSpecCatalog 目录分组（内置序 + 自定义组）', () => {
  it('内置形按声明序成组（有条目才出组）；custom 条目归「自定义」组', () => {
    const groups = groupSpecCatalog(CATALOG)
    expect(groups.map((g) => g.shapeId)).toEqual(['round', 'square', 'drop', 'custom'])
    expect(groups[0].sizes).toHaveLength(2)
    expect(groups[3].label).toBe('自定义')
    expect(groupSpecCatalog([])).toEqual([])
  })
})

describe('buildSpecChanges 批量改规格（四键对称）', () => {
  const roundGem = { id: 'g1', shapeId: 'round' as const, diameterMm: 2.8, colorId: 'red' }
  const customGem = { id: 'g2', shapeId: 'custom' as const, diameterMm: 5, colorId: 'gold', assetId: 'ast-c1' }

  it('builtin→builtin：shapeId/diameterMm/colorId 改写（assetId 双侧 undefined）', () => {
    const changes = buildSpecChanges([roundGem], { shapeId: 'square', diameterMm: 3.5, colorId: 'black' })
    expect(changes).toEqual([
      {
        id: 'g1',
        before: { shapeId: 'round', diameterMm: 2.8, colorId: 'red', assetId: undefined },
        after: { shapeId: 'square', diameterMm: 3.5, colorId: 'black', assetId: undefined },
      },
    ])
  })

  it('custom⇄builtin 双向：assetId 随形同改（写入/清除）', () => {
    const toCustom = buildSpecChanges([roundGem], { shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' })
    expect(toCustom[0].after).toMatchObject({ shapeId: 'custom', assetId: 'ast-c1' })
    const toBuiltin = buildSpecChanges([customGem], { shapeId: 'round', diameterMm: 2.8, colorId: 'red' })
    expect(toBuiltin[0].before).toMatchObject({ shapeId: 'custom', assetId: 'ast-c1' })
    expect(toBuiltin[0].after).toMatchObject({ shapeId: 'round', assetId: undefined })
  })

  it('custom→custom 换资产：assetId 改写', () => {
    const changes = buildSpecChanges([customGem], { shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: 'ast-c2' })
    expect(changes[0].after.assetId).toBe('ast-c2')
  })

  it('全等钻不入 changes（无变更不产组）；空批 = []', () => {
    expect(buildSpecChanges([roundGem], { shapeId: 'round', diameterMm: 2.8, colorId: 'red' })).toEqual([])
    expect(buildSpecChanges([], { shapeId: 'round', diameterMm: 2.8, colorId: 'red' })).toEqual([])
  })

  it('非法规格守卫：custom 缺 assetId / builtin 带 assetId = throw（setBrushSpec 同判据）', () => {
    expect(() => buildSpecChanges([roundGem], { shapeId: 'custom', diameterMm: 5, colorId: 'red' })).toThrow()
    expect(() =>
      buildSpecChanges([roundGem], { shapeId: 'round', diameterMm: 2.8, colorId: 'red', assetId: 'x' }),
    ).toThrow()
  })
})

describe('pushRecentSpec 最近使用（去重首出 + 上限）', () => {
  it('新规格首出；重复应用去重上提；超上限裁最旧', () => {
    pushRecentSpec({ shapeId: 'round', diameterMm: 2.8, colorId: 'red' }, 'R10')
    pushRecentSpec({ shapeId: 'square', diameterMm: 3.5, colorId: 'black' }, 'SQ35')
    pushRecentSpec({ shapeId: 'round', diameterMm: 2.8, colorId: 'red' }, 'R10') // 去重上提
    let recent: RecentSpec[] = getRecentSpecs()
    expect(recent.map((r) => r.label)).toEqual(['R10', 'SQ35'])

    for (let i = 0; i < MAX_RECENT_SPECS + 2; i++) {
      pushRecentSpec({ shapeId: 'round', diameterMm: 1 + i, colorId: 'red' }, `R${i}`)
    }
    recent = getRecentSpecs()
    expect(recent).toHaveLength(MAX_RECENT_SPECS)
    expect(recent[0].label).toBe(`R${MAX_RECENT_SPECS + 1}`) // 最新在首
  })
})

// ---------------------------------------------------------------------------
// 命令总线 apply-spec（design §6.2 唯一写入口——禁第二实现）
// ---------------------------------------------------------------------------

describe('apply-spec 命令（规格选择器/右键改规格▸ 同源）', () => {
  it('空选：写 brushSpec 真源（当前规格跟随），不产 undo 组', () => {
    const ok = execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'square', diameterMm: 3.5, colorId: 'black' },
      label: 'SQ35',
    })
    expect(ok).toBe(true)
    expect(getBrushSpec()).toEqual({ shapeId: 'square', diameterMm: 3.5, colorId: 'black' })
    expect(getRecentSpecs()[0]).toMatchObject({ label: 'SQ35' })
    expect(getUndoDepths().undo).toBe(0)
  })

  it('选中 3 颗：批量改规格 = 单 undo 组；undo 逐字段恢复（shape/diameter/color）', () => {
    setSelection(['g00001', 'g00002', 'g00003'])
    const before = ['g00001', 'g00002', 'g00003'].map((id) => ({
      shapeId: gem(id).shapeId,
      diameterMm: gem(id).diameterMm,
      colorId: gem(id).colorId,
    }))
    const ok = execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'square', diameterMm: 3.5, colorId: 'gold' },
      label: 'SQ35',
    })
    expect(ok).toBe(true)
    expect(getUndoDepths().undo).toBe(1) // 单 undo 组（批量 = 一组）
    for (const id of ['g00001', 'g00002', 'g00003']) {
      expect(gem(id)).toMatchObject({ shapeId: 'square', diameterMm: 3.5, colorId: 'gold' })
    }
    expect(gem('g00004').shapeId).toBe('round') // 选集外不动

    undo()
    ;['g00001', 'g00002', 'g00003'].forEach((id, i) => {
      expect(gem(id)).toMatchObject(before[i]) // 逐字段恢复（fixture 各钻原色各异）
    })
  })

  it('选中钻改 custom：物化 assetId；undo 恢复（assetId 清回 undefined）', () => {
    setSelection(['g00001'])
    const ok = execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' },
      label: '星芒 5mm',
    })
    expect(ok).toBe(true)
    expect(gem('g00001')).toMatchObject({ shapeId: 'custom', diameterMm: 5, assetId: 'ast-c1' })
    expect(getBrushSpec()).toMatchObject({ shapeId: 'custom', assetId: 'ast-c1' })

    undo()
    expect(gem('g00001').shapeId).toBe('round')
    expect(gem('g00001').assetId).toBeUndefined()
  })

  it('custom 钻改回 builtin：assetId 清除（builtin 不得带 assetId——engine schema）', () => {
    // 备一颗 custom 钻（经 apply-spec 两次：先 custom 后换 builtin）
    setSelection(['g00001'])
    execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' }, label: '' })
    undo()
    execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' }, label: '' })
    execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'round', diameterMm: 2.8, colorId: 'red' }, label: 'R10' })
    const g = gem('g00001')
    expect(g.shapeId).toBe('round')
    expect(g.assetId).toBeUndefined()
  })

  it('非法规格（custom 缺 assetId / builtin 带 assetId）：拒绝零写入（真源/选中钻/组均不动）', () => {
    setSelection(['g00001'])
    expect(
      execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'custom', diameterMm: 5, colorId: 'red' }, label: '' }),
    ).toBe(false)
    expect(
      execDesignerCommand({ kind: 'apply-spec', spec: { shapeId: 'round', diameterMm: 2.8, colorId: 'red', assetId: 'x' }, label: '' }),
    ).toBe(false)
    expect(getBrushSpec()).toBeNull()
    expect(gem('g00001').shapeId).toBe('round')
    expect(getUndoDepths().undo).toBe(0)
    expect(getRecentSpecs()).toHaveLength(0)
  })

  it('全等应用（选中钻已在规格）：不产 undo 组，真源与最近仍记录', () => {
    setSelection(['g00001'])
    const ok = execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'round', diameterMm: 2.8, colorId: 'red' },
      label: 'R10',
    })
    expect(ok).toBe(true)
    expect(getUndoDepths().undo).toBe(0) // 无变更不产组
    expect(getBrushSpec()).toEqual({ shapeId: 'round', diameterMm: 2.8, colorId: 'red' })
    expect(getRecentSpecs()[0].label).toBe('R10')
  })

  it('custom 应用 prefetch 资产解析（gemCatalogService 消费——就绪后可落钻）', async () => {
    setBrushCatalogForTests(fakeCatalogService())
    execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'custom', diameterMm: 5, colorId: 'gold', assetId: 'ast-c1' },
      label: '星芒 5mm',
    })
    expect(brushAssetStatusOf('ast-c1')).toBe('pending') // 起笔前 prefetch 已发出
    await waitFor(() => brushAssetStatusOf('ast-c1') === 'ready')

    // 就绪后 custom 可落钻（3.1 拒画防线联动）
    const detach = attachBrushEngine()
    emitBrushEvent({ phase: 'begin', intent: { tool: 'draw', snap: 'free', points: [{ x: 2, y: 24 }] } })
    emitBrushEvent({ phase: 'end', intent: { tool: 'draw', snap: 'free', points: [{ x: 2, y: 24 }] } })
    const added = getEditDoc()!.gems.filter((g) => g.origin === 'manual')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ shapeId: 'custom', assetId: 'ast-c1' })
    detach()
  })
})

describe('open-spec-selector 命令（UI 钩子——delete-selection 同源模式）', () => {
  it('无钩子返回 false；装钩子后调用并返回 true', () => {
    expect(execDesignerCommand({ kind: 'open-spec-selector' })).toBe(false)
    let opened = false
    const hooks: DesignerUiHooks = {
      requestDeleteConfirm: () => {},
      requestOpenSpecSelector: () => {
        opened = true
      },
    }
    installDesignerUiHooks(hooks)
    expect(execDesignerCommand({ kind: 'open-spec-selector' })).toBe(true)
    expect(opened).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hexSnap 吸附随规格 pitch 重算（design §6.1：格位 = 当前规格 pitch 六方格位）
// ---------------------------------------------------------------------------

describe('brushSnapPitchPx（吸附 pitch 单源）', () => {
  it('基准派生态与 pitchPx(grid) 逐位相等（语义回归基线）', () => {
    const doc = getEditDoc()!
    expect(brushSnapPitchPx(doc)).toBe(pitchPx(doc.grid)) // SS10 基准：与文档格 pitch 同值
    expect(brushSnapPitchPx(doc)).toBeCloseTo(TEST_PITCH, 10) // 8px（浮点 ULP 内）
  })

  it('覆盖态随规格重算：round 4.8mm → (4.8+0.4)×2.5=13px；custom 5mm → 13.5px', () => {
    const doc = getEditDoc()!
    setBrushSpec({ shapeId: 'round', diameterMm: 4.8, colorId: 'red' })
    expect(brushSnapPitchPx(doc)).toBe(13)
    setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' })
    expect(brushSnapPitchPx(doc)).toBe(13.5)
    setBrushSpec(null)
  })

  it('画布落点吸附消费单源：4.8mm 规格下 pointer 落点吸附 pitch-13 格位', async () => {
    const view = mountView()
    await tick()
    setBrushSpec({ shapeId: 'round', diameterMm: 4.8, colorId: 'red' })
    view.target.querySelector<HTMLButtonElement>('[data-testid="designer-tool-draw"]')!.click()
    await tick()

    const events: Parameters<Parameters<typeof onBrushStroke>[0]>[0][] = []
    const unsubscribe = onBrushStroke((e) => events.push(e))
    const canvas = view.canvas()!
    pointer(canvas, 'pointerdown', { x: 10, y: 10 })
    pointer(canvas, 'pointerup', { x: 10, y: 10 })

    // 期望值 = hexSnapPoint(·, ·, 13) 单源计算（奇数行 x=6.5 格位——pitch-13 格阵）
    expect(events[0].intent.points[0]).toEqual(hexSnapPoint(10, 10, 13))
    expect(events[0].intent.points[0]).not.toEqual(hexSnapPoint(10, 10, 8)) // 非旧文档格 pitch
    unsubscribe()
    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// 组件面（DesignerView 全链：选择器弹层 + 右键「改规格▸」子树）
// ---------------------------------------------------------------------------

describe('DesignerSpecSelector（顶栏规格选择器）', () => {
  it('触发钮打开弹层；目录经 gemCatalogService 注入消费（形×档分组呈现）', async () => {
    setSpecCatalogForTests(fakeCatalogService())
    const view = mountView()
    await tick()
    view.q('designer-spec-trigger')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-spec-popover') !== null)
    await waitFor(() => getSpecCatalog().length > 0)

    expect(view.q('designer-spec-shape-round')).not.toBeNull()
    expect(view.q('designer-spec-shape-square')).not.toBeNull()
    expect(view.q('designer-spec-shape-custom-ast-c1')).not.toBeNull()
    // 基准规格（round 2.8=SS10）触发钮人读规格码
    expect(view.q('designer-spec-trigger')!.textContent).toContain('R10')

    view.unmount()
  })

  it('档位应用：选中 2 颗 → 批量改规格单 undo 组 + brushSpec 真源 + 最近规格', async () => {
    setSpecCatalogForTests(fakeCatalogService())
    setSelection(['g00001', 'g00002'])
    const view = mountView()
    await tick()
    view.q('designer-spec-trigger')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-spec-size-round-ss16') !== null)

    view.q('designer-spec-target-hint')!.textContent!.includes('2')
    view.q('designer-spec-size-round-ss16')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(gem('g00001')).toMatchObject({ shapeId: 'round', diameterMm: 4 })
    expect(gem('g00002')).toMatchObject({ shapeId: 'round', diameterMm: 4 })
    expect(getUndoDepths().undo).toBe(1)
    expect(getBrushSpec()).toEqual({ shapeId: 'round', diameterMm: 4, colorId: 'red' })
    expect(getRecentSpecs()[0].label).toBe('R16')

    view.unmount()
  })

  it('色板换色：色独立维度应用（形/档保持）', async () => {
    setSpecCatalogForTests(fakeCatalogService())
    const view = mountView()
    await tick()
    view.q('designer-spec-trigger')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-spec-color-gold') !== null)

    view.q('designer-spec-color-gold')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getBrushSpec()).toEqual({ shapeId: 'round', diameterMm: 2.8, colorId: 'gold' }) // 基准形/径保持

    view.unmount()
  })
})

describe('右键「改规格▸」子树（design §2.2 回填）', () => {
  it('最近使用规格经命令总线应用到选中钻；「更多…」打开规格选择器', async () => {
    setSpecCatalogForTests(fakeCatalogService())
    setSelection(['g00001'])
    // 预置最近规格（apply-spec 单写入口）
    execDesignerCommand({
      kind: 'apply-spec',
      spec: { shapeId: 'square', diameterMm: 3.5, colorId: 'black' },
      label: 'SQ35',
    })
    undo() // 撤销批量改（保留最近记录语义面），选中恢复
    setSelection(['g00001'])

    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    contextmenu(canvas, { x: 4, y: 4 }) // 钻上右键 → 选中态树
    await waitFor(() => view.q('designer-context-menu') !== null)

    view.q('designer-menu-spec')!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-menu-spec-recent-0') !== null)
    expect(view.q('designer-menu-spec-recent-0')!.textContent).toContain('SQ35')

    view.q('designer-menu-spec-recent-0')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(gem('g00001')).toMatchObject({ shapeId: 'square', diameterMm: 3.5, colorId: 'black' })
    expect(getUndoDepths().undo).toBe(1)

    // 「更多…」→ 命令总线 open-spec-selector → UI 钩子 → 顶栏选择器弹层
    contextmenu(canvas, { x: 4, y: 4 })
    await waitFor(() => view.q('designer-menu-spec') !== null)
    view.q('designer-menu-spec')!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-menu-spec-more') !== null)
    view.q('designer-menu-spec-more')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => getSpecSelectorOpen())
    await waitFor(() => view.q('designer-spec-popover') !== null)

    view.unmount()
  })

  it('无最近规格时子树仅「更多…」（不显空段分隔线）', async () => {
    const view = mountView()
    await tick()
    const canvas = view.canvas()!
    contextmenu(canvas, { x: 4, y: 4 })
    await waitFor(() => view.q('designer-context-menu') !== null)
    view.q('designer-menu-spec')!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => view.q('designer-menu-spec-more') !== null)
    expect(view.q('designer-menu-spec-recent-0')).toBeNull()

    view.unmount()
  })
})

// ---------------------------------------------------------------------------
// 语义回归：BrushSpecShapeError 判据替换后导出面保持（3.1 既有契约面）
// ---------------------------------------------------------------------------

describe('契约面回归', () => {
  it('setBrushSpec 判据守卫仍可用（custom 缺 assetId throw；合法写入放行）', () => {
    expect(() => setBrushSpec({ shapeId: 'custom', diameterMm: 5, colorId: 'red' })).toThrow(BrushSpecShapeError)
    const spec: BrushSpecState = { shapeId: 'custom', diameterMm: 5, colorId: 'red', assetId: 'ast-c1' }
    setBrushSpec(spec)
    expect(getBrushSpec()).toEqual(spec)
    setBrushSpec(null)
  })

  it('loadSpecCatalog：注入目录拉取 ready；异常置 error 不抛', async () => {
    setSpecCatalogForTests(fakeCatalogService())
    await loadSpecCatalog()
    expect(getSpecCatalog()).toHaveLength(CATALOG.length)
    resetSpecSelectorForTests()
    setSpecCatalogForTests({
      async listSpecs() {
        throw new Error('IDB 不可用')
      },
      async resolveSpec() {
        return undefined
      },
    })
    await loadSpecCatalog()
    expect(getSpecCatalog()).toEqual([])
  })
})
