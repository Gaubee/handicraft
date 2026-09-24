/*
 * 仓储管理工作台挂载与交互（add-stone-library S7.4，design §7.6）：
 * 多标准纵向分组流渲染（双标准同编号段）、段内筛选、大样卡虚拟窗口、marquee
 * 框选（pointer 三事件全链）、点选 toggle、加入集合→侧栏限定名/汇总、数量行内
 * 编辑、成员移除、缺失警示（五态红边徽标）、CAS 漂移横幅+刷新重载。
 * fixture 注入见 fixtures.ts；jsdom 桩：ResizeObserver/视口 defineProperty。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import WarehouseView from '../../components/warehouse/WarehouseView.svelte'
import { makeWarehouseClient, makeWarehouseCells, type SetsFixtureCalls } from './fixtures'
import { makeCell } from '../stonesAdmin/fixtures'
import { WAREHOUSE_CELL_H } from '$lib/warehouse/layout'
import { STONE_GRID_GAP } from '$lib/stonesAdmin/virtual'
import {
  addWarehouseSelection,
  bindWarehouseClient,
  resetWarehouseForTests,
  switchWarehouseSet,
  setWarehouseMemberQuantity,
  getWarehouseSelection,
} from '$lib/warehouse/store.svelte'
import type { StoneGridCell } from '@handicraft/contracts'
import type { WarehouseClient } from '$lib/warehouse/store.svelte'

// jsdom 未实现 ResizeObserver；视图测量面依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let calls: SetsFixtureCalls
let client: WarehouseClient

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  const fixture = makeWarehouseClient({
    sets: [
      {
        label: 'alpha',
        name: '卡通套餐-A',
        members: [
          { stoneRef: 'res-yh-j51', quantity: 2 },
          { stoneRef: 'res-fb-j51' },
        ],
      },
      {
        label: 'broken',
        name: '缺引用套餐',
        members: [{ stoneRef: 'res-gone', quantity: 1 }],
      },
    ],
    memberStates: { 'res-gone': 'not-found' },
  })
  calls = fixture.calls
  client = fixture.client
  resetWarehouseForTests()
  bindWarehouseClient(fixture.client)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

function click(selector: string): void {
  const el = q(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(selector: string, value: string): void {
  const el = q(selector) as HTMLInputElement | null
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.value = value
  el!.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mountView(cells?: StoneGridCell[]): Promise<{ unmount: () => void }> {
  if (cells !== undefined) {
    const fixture = makeWarehouseClient({ cells })
    resetWarehouseForTests()
    bindWarehouseClient(fixture.client)
  }
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(WarehouseView, { target })
  await flush()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function stubViewport(container: Element | null, width: number, height: number): void {
  expect(container, '滚动容器应存在').not.toBeNull()
  Object.defineProperty(container!, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(container!, 'clientHeight', { value: height, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

function pointer(selector: string, type: string, x: number, y: number): void {
  const el = q(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
}

// ---------------------------------------------------------------------------
// 多标准纵向分组流
// ---------------------------------------------------------------------------

describe('WarehouseView 分组流渲染', () => {
  it('双标准段渲染（段头=标准 ID+计数）；同编号 J51 两段各自在场', async () => {
    const { unmount } = await mountView()
    expect(q('[data-testid="warehouse-section-header-yuhang"]')?.textContent).toContain('yuhang')
    expect(q('[data-testid="warehouse-section-header-factoryB"]')?.textContent).toContain('factoryB')
    // 同编号 J51：yuhang 段与 factoryB 段各一（编号冲突——限定名区分归侧栏）
    expect(q('[data-testid="stone-cell-res-yh-j51"]')).not.toBeNull()
    expect(q('[data-testid="stone-cell-res-fb-j51"]')).not.toBeNull()
    expect(q('[data-testid="warehouse-status-sections"]')?.textContent).toContain('2 个标准')
    unmount()
  })

  it('段内筛选（搜索）：段内收窄、他段不受影响', async () => {
    const { unmount } = await mountView()
    expect(q('[data-testid="stone-cell-res-yh-a51"]')).not.toBeNull()
    type('[data-testid="warehouse-section-q-yuhang"]', '米白')
    q('[data-testid="warehouse-section-q-yuhang"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    await flush()
    expect(q('[data-testid="stone-cell-res-yh-a51"]')).toBeNull()
    expect(q('[data-testid="stone-cell-res-yh-j52"]')).not.toBeNull()
    // 他段不受段内筛选影响
    expect(q('[data-testid="stone-cell-res-fb-j51"]')).not.toBeNull()
    unmount()
  })

  it('折叠段：网格收起（cells 卸载、段头保留）', async () => {
    const { unmount } = await mountView()
    click('[data-testid="warehouse-section-collapse-yuhang"]')
    await flush()
    expect(q('[data-testid="warehouse-section-yuhang"]')?.getAttribute('data-collapsed')).toBe('true')
    expect(q('[data-testid="stone-cell-res-yh-j51"]')).toBeNull()
    expect(q('[data-testid="stone-cell-res-fb-j51"]')).not.toBeNull()
    unmount()
  })

  it('S7.7 段头筛选行让位：搜索框 min-w-0 可缩、无 flex-wrap（不溢出/不被侧栏剪裁）', async () => {
    const { unmount } = await mountView()
    const header = q('[data-testid="warehouse-section-header-yuhang"]')
    expect(header, '段头应存在').not.toBeNull()
    // 固定高段头去 flex-wrap——wrap 行会被 44px 固定高剪掉（剪裁回归防线）
    expect(header!.className).not.toContain('flex-wrap')
    // 搜索框让位：label min-w-0 + flex-1（压力下收缩而非溢出）
    const searchLabel = q('[data-testid="warehouse-section-q-yuhang"]')?.closest('label')
    expect(searchLabel, '搜索框 label 应存在').not.toBeNull()
    expect(searchLabel!.className).toContain('min-w-0')
    expect(searchLabel!.className).toContain('flex-1')
    // 色系筛选固定宽不被挤压
    const familyTrigger = q('[data-testid="warehouse-section-family-yuhang"]')
    expect(familyTrigger?.className).toContain('shrink-0')
    // 集合侧栏固定宽不挤压（搜索框让位的另一半约定）
    const aside = q('[data-testid="warehouse-set-sidebar"]')?.parentElement
    expect(aside?.className).toContain('w-96')
    expect(aside?.className).toContain('shrink-0')
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 虚拟滚动（大样卡护栏）
// ---------------------------------------------------------------------------

describe('WarehouseView 虚拟窗口', () => {
  it('300+ 项单段：只渲染窗口子集；滚动后窗口平移', async () => {
    const bulk: StoneGridCell[] = [
      ...makeWarehouseCells(),
      ...Array.from({ length: 300 }, (_, i) =>
        makeCell({ resourceId: `res-bulk-${i}`, sku: `S${i}`, supplier: 'yuhang', name: `合成 · ${i}`, textureUrl: `/api/stones/res-bulk-${i}/texture.png` }),
      ),
    ]
    const { unmount } = await mountView(bulk)
    const scroller = q('[data-testid="warehouse-flow-scroll"]')
    stubViewport(scroller, 1000, 500)
    await flush()

    const renderedBefore = qq('[data-testid^="stone-cell-res-bulk-"]')
    expect(renderedBefore.length).toBeGreaterThan(0)
    expect(renderedBefore.length).toBeLessThan(300)

    const scrollerEl = scroller as HTMLDivElement
    scrollerEl.scrollTop = (WAREHOUSE_CELL_H + STONE_GRID_GAP) * 30
    scrollerEl.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flush()
    const idsAfter = qq('[data-testid^="stone-cell-res-bulk-"]').map((el) =>
      Number(el.getAttribute('data-testid')!.replace('stone-cell-res-bulk-', '')),
    )
    // 1000px 视口 6 列；stride 128（S7.7 行槽=瓦片实际高）、段头 44 偏移下首可见行
    // 29 → 窗口起行 26（−overscan 3）；bulk 合成格在段内偏移 +3（j51/a51/j52 在前）
    // → 首渲染 bulk id ≥ 26*6−3。
    expect(Math.min(...idsAfter)).toBeGreaterThanOrEqual(26 * 6 - 3)
    expect(idsAfter.length).toBeLessThan(300)
    unmount()
  })

  it('S7.7 行槽对齐：连续行 y 差=行槽高+gap、槽高=WAREHOUSE_CELL_H（无死空间）', async () => {
    const bulk: StoneGridCell[] = [
      ...makeWarehouseCells(),
      ...Array.from({ length: 60 }, (_, i) =>
        makeCell({ resourceId: `res-slot-${i}`, sku: `T${i}`, supplier: 'yuhang', name: `槽高 · ${i}`, textureUrl: `/api/stones/res-slot-${i}/texture.png` }),
      ),
    ]
    const { unmount } = await mountView(bulk)
    const scroller = q('[data-testid="warehouse-flow-scroll"]')
    stubViewport(scroller, 1000, 500)
    await flush()

    const grid = q('[data-testid="warehouse-section-grid-yuhang"]')
    expect(grid, '段网格画布应存在').not.toBeNull()
    const slots = [...grid!.children].filter((el) => el.classList.contains('absolute'))
    expect(slots.length).toBeGreaterThan(6) // 多行在场（1000px 视口 6 列）

    // 槽高=瓦片实际高（行槽高≠槽高即死空间回归）
    for (const slot of slots) {
      expect((slot as HTMLElement).style.height).toBe(`${WAREHOUSE_CELL_H}px`)
    }
    // 连续行 y 差=行槽高+gap（top 解析自绝对定位内联样式）
    const rowTops = [...new Set(slots.map((el) => parseInt((el as HTMLElement).style.top, 10)))].sort((a, b) => a - b)
    expect(rowTops.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < rowTops.length; i += 1) {
      expect(rowTops[i]! - rowTops[i - 1]!).toBe(WAREHOUSE_CELL_H + STONE_GRID_GAP)
    }
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 框选 / 点选 / 加入集合（Owner 核心动线）
// ---------------------------------------------------------------------------

describe('WarehouseView 框选+点选→加入集合', () => {
  it('marquee 拖拽（pointerdown→move→up）：矩形命中并集入选择集+实时高亮', async () => {
    const { unmount } = await mountView()
    // jsdom 零视口退化=单列；yuhang 段 3 格纵向（stride 128，末行底 372）：
    // clientY 50..460 覆盖三行、不越段（factoryB 首格顶 484——S7.7 行槽收窄后段顶上移）。
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointerdown', 50, 50)
    // 拖拽中：marquee 覆盖层+实时命中（选中态高亮）
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointermove', 200, 460)
    await flush()
    expect(q('[data-testid="warehouse-marquee"]')).not.toBeNull()
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointerup', 200, 460)
    await flush()
    expect(q('[data-testid="warehouse-marquee"]')).toBeNull()
    expect(q('[data-testid="warehouse-selection-count"]')?.textContent).toContain('已选 3')
    unmount()
  })

  it('点选 toggle（平铺单元点击）+框选混合累加', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stone-cell-res-fb-j51"]')
    await flush()
    expect(q('[data-testid="warehouse-selection-count"]')?.textContent).toContain('已选 1')
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointerdown', 50, 50)
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointermove', 200, 460)
    pointer('[data-testid="warehouse-flow-scroll"]', 'pointerup', 200, 460)
    await flush()
    expect(getWarehouseSelection().sort()).toEqual(['res-fb-j51', 'res-yh-a51', 'res-yh-j51', 'res-yh-j52'])
    // 再点取消
    click('[data-testid="stone-cell-res-fb-j51"]')
    await flush()
    expect(getWarehouseSelection()).toHaveLength(3)
    unmount()
  })

  it('tile 上按下不启动 marquee（按钮目标跳过）', async () => {
    const { unmount } = await mountView()
    pointer('[data-testid="stone-cell-res-yh-j51"]', 'pointerdown', 50, 50)
    pointer('[data-testid="stone-cell-res-yh-j51"]', 'pointermove', 200, 600)
    pointer('[data-testid="stone-cell-res-yh-j51"]', 'pointerup', 200, 600)
    await flush()
    expect(q('[data-testid="warehouse-selection-count"]')?.textContent).toContain('已选 0')
    unmount()
  })

  it('加入集合→侧栏限定名（双标准同编号区分）+汇总；移除成员', async () => {
    const { unmount } = await mountView()
    addWarehouseSelection(['res-yh-j51', 'res-fb-j51'])
    click('[data-testid="warehouse-add-to-set"]')
    await flush()
    // 限定名落点：yuhang/J51 vs factoryB/J51（编号冲突自动区分）
    expect(q('[data-testid="warehouse-member-res-yh-j51"]')?.textContent).toContain('yuhang/J51')
    expect(q('[data-testid="warehouse-member-res-fb-j51"]')?.textContent).toContain('factoryB/J51')
    expect(q('[data-testid="warehouse-set-summary"]')?.textContent).toContain('成员 2')
    // 平铺区「在集合」徽标（增删同步的可视面）
    expect(q('[data-testid="warehouse-inset-badge-res-yh-j51"]')).not.toBeNull()
    // 数量行内编辑 → 汇总求和
    type('[data-testid="warehouse-member-qty-res-yh-j51"]', '3')
    await flush()
    expect(q('[data-testid="warehouse-set-summary"]')?.textContent).toContain('总数量 3')
    expect(q('[data-testid="warehouse-set-summary"]')?.textContent).toContain('1 项按设计用量另计')
    // 备注行内编辑
    type('[data-testid="warehouse-member-note-res-fb-j51"]', '辅石')
    // 移除成员
    click('[data-testid="warehouse-member-remove-res-fb-j51"]')
    await flush()
    expect(q('[data-testid="warehouse-member-res-fb-j51"]')).toBeNull()
    expect(q('[data-testid="warehouse-set-summary"]')?.textContent).toContain('成员 1')
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 既有组合 / 缺失警示 / CAS 漂移
// ---------------------------------------------------------------------------

describe('WarehouseView 既有组合侧栏', () => {
  it('切换器装载既有组合：成员贴图墙+限定名+汇总+数量编辑', async () => {
    const { unmount } = await mountView()
    await switchWarehouseSet('set-alpha')
    await flush()
    expect(q('[data-testid="warehouse-set-switcher"]')?.textContent).toContain('卡通套餐-A')
    expect(q('[data-testid="warehouse-member-res-yh-j51"]')?.textContent).toContain('yuhang/J51')
    expect(q('[data-testid="warehouse-member-qty-res-yh-j51"]')).not.toBeNull()
    expect(q('[data-testid="warehouse-set-summary"]')?.textContent).toContain('总数量 2')
    expect(q('[data-testid="warehouse-save-changes"]')).not.toBeNull()
    // 编辑后保存可点（dirty）
    type('[data-testid="warehouse-set-name"]', '套餐改名')
    setWarehouseMemberQuantity('res-yh-j51', 5)
    await flush()
    expect((q('[data-testid="warehouse-save-changes"]') as HTMLButtonElement | null)?.disabled).toBe(false)
    unmount()
  })

  it('缺失成员显式呈现不剔除（红边徽标+警示行）', async () => {
    const { unmount } = await mountView()
    await switchWarehouseSet('set-broken')
    await flush()
    expect(q('[data-testid="warehouse-member-res-gone"]')).not.toBeNull()
    expect(q('[data-testid="warehouse-member-missing-res-gone"]')?.textContent).toContain('引用不存在')
    expect(q('[data-testid="warehouse-set-missing-warning"]')?.textContent).toContain('缺失 1')
    expect(q('[data-testid="warehouse-member-res-gone"]')?.textContent).toContain('未解析/')
    unmount()
  })

  it('CAS 漂移→提示横幅+刷新重载按钮（不盲写呈现）', async () => {
    const { unmount } = await mountView()
    await switchWarehouseSet('set-alpha')
    // 外部端推进 revision（他人保存）
    await client.sets.update({ resourceId: 'set-alpha', baseRevision: 3, patch: { name: '外部改名' } })
    setWarehouseMemberQuantity('res-yh-j51', 9)
    // 保存撞 CAS → 漂移横幅
    q('[data-testid="warehouse-save-changes"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    expect(q('[data-testid="warehouse-drift-banner"]')).not.toBeNull()
    expect((q('[data-testid="warehouse-save-changes"]') as HTMLButtonElement | null)?.disabled).toBe(true)
    // 刷新重载：横幅消退、草稿复位（name 输入框 value 属性同步）
    click('[data-testid="warehouse-drift-reload"]')
    await flush()
    expect(q('[data-testid="warehouse-drift-banner"]')).toBeNull()
    expect((q('[data-testid="warehouse-set-name"]') as HTMLInputElement | null)?.value).toContain('外部改名')
    unmount()
  })
})
