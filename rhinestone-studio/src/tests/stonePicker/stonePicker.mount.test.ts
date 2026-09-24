/**
 * 钻表选择器组件测试（add-stone-library S5.3——jsdom 基础视觉自查；vision 走查归 S7.7）：
 * 三排板形态（按色三级/按尺寸档→色阵）/搜索/选中产出 StonePick 契约/ΔE 推荐渲染
 * （含中性灰底防线）/空态与引用四态缺失标注/activeSetId 接口位徽标/错误态重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { StonePickSchema } from '@handicraft/contracts'
import StonePicker from '../../components/stone-picker/StonePicker.svelte'
import { StonePickerStore } from '$lib/stonePicker/store.svelte.js'
import { MockStonePickerSource, makeCell, type CellSpec } from './helpers.js'
import type { StoneGridCell, StonePick } from '@handicraft/contracts'

let mounted: Array<() => void> = []

beforeEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  document.body.innerHTML = ''
})

async function flush(ms = 25): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface Mounted {
  store: StonePickerStore
  source: MockStonePickerSource
  picks: Array<{ pick: StonePick; cell: StoneGridCell }>
}

async function mountPicker(options: {
  cells?: CellSpec[]
  gets?: Record<string, { resourceId: string; state: 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind'; gemshapeRef?: string }>
  searchDebounceMs?: number
} = {}): Promise<Mounted> {
  const source = new MockStonePickerSource({
    cells: options.cells === undefined ? undefined : options.cells.map((spec) => makeCell(spec)),
    gets: options.gets,
  })
  const store = new StonePickerStore(source, { searchDebounceMs: options.searchDebounceMs ?? 0 })
  const picks: Mounted['picks'] = []
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StonePicker, {
    target,
    props: { store, onPick: (pick, cell) => picks.push({ pick, cell }) },
  })
  mounted.push(() => {
    unmount(app)
    target.remove()
  })
  await flush()
  return { store, source, picks }
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  return el as HTMLElement
}

function click(selector: string): void {
  q(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function submit(selector: string): void {
  q(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

function type(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('StonePicker 排板形态（S5.1）', () => {
  it('按色三级：色系 chips→款式行折叠→尺寸变体贴图（懒展开）；贴图 URL 走 resolveTextureUrl+中性灰底', async () => {
    await mountPicker()
    // 一级：色系 chips（默认选首族）
    expect(q('[data-testid="stone-family-白色系"]')).toBeDefined()
    expect(q('[data-testid="stone-family-红色系"]')).toBeDefined()
    // 二级：款式行折叠头（row-51/row-52/未编行）
    expect(q('[data-testid="stone-style-row-51"]')).toBeDefined()
    expect(q('[data-testid="stone-style-未编行"]')).toBeDefined()
    // 展开前无变体贴图
    expect(document.querySelector('[data-testid="stone-cell-stn-j51"]')).toBeNull()
    click('[data-testid="stone-style-row-51"]')
    await flush()
    // 三级：尺寸变体（2/3/4mm 同款式行）
    for (const id of ['stn-a51', 'stn-b51', 'stn-j51']) {
      expect(q(`[data-testid="stone-cell-${id}"]`)).toBeDefined()
    }
    // 贴图：URL 絕对化 + 预览底色=中性灰（非纯白——白钻隐形防线）
    const img = q('[data-testid="stone-cell-stn-j51"] img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/mock-daemon/api/stones/stn-j51/texture.png')
    expect(q('[data-testid="stone-tile-stn-j51"] .bg-zinc-300')).toBeDefined()
    // 未声明尺寸徽标（§8.1 规则 7——显式标注不猜测）
    click('[data-testid="stone-style-未编行"]')
    await flush()
    expect(q('[data-testid="stone-size-unset-stn-m01"]').textContent).toContain('未声明尺寸')
  })

  it('切色系：款式行随 family 子查询刷新', async () => {
    await mountPicker()
    click('[data-testid="stone-family-红色系"]')
    await flush()
    expect(q('[data-testid="stone-style-row-60"]')).toBeDefined()
    expect(document.querySelector('[data-testid="stone-style-row-51"]')).toBeNull()
  })

  it('按尺寸排板：档 chips（未声明殿后）→同径色阵', async () => {
    await mountPicker()
    click('[data-testid="stone-layout-size"]')
    await flush()
    for (const tier of ['2', '3', '4', '未声明']) {
      expect(q(`[data-testid="stone-tier-${tier}"]`)).toBeDefined()
    }
    expect(q('[data-testid="stone-tier-2"]').getAttribute('aria-selected')).toBe('true')
    // 同径色阵：2mm=白×3+红
    for (const id of ['stn-j51', 'stn-j52', 'stn-j60']) {
      expect(q(`[data-testid="stone-cell-${id}"]`)).toBeDefined()
    }
    click('[data-testid="stone-tier-未声明"]')
    await flush()
    expect(q('[data-testid="stone-cell-stn-m01"]')).toBeDefined()
    expect(document.querySelector('[data-testid="stone-cell-stn-j51"]')).toBeNull()
  })
})

describe('StonePicker 搜索（S5.1）', () => {
  it('十六进制搜索：q 透传+结果收敛到红色系；无匹配空态', async () => {
    const { source } = await mountPicker()
    type('[data-testid="stone-search-input"]', '#E02020')
    await flush(40)
    expect(source.calls.at(-1)!.q).toBe('#E02020')
    expect(q('[data-testid="stone-family-红色系"]')).toBeDefined()
    expect(document.querySelector('[data-testid="stone-family-白色系"]')).toBeNull()

    type('[data-testid="stone-search-input"]', 'ZZZ999')
    await flush(40)
    expect(q('[data-testid="stone-empty"]').textContent).toContain('无匹配结果')
  })

  it('SKU 搜索：' + 'J51 直达款式行', async () => {
    await mountPicker()
    type('[data-testid="stone-search-input"]', 'J51')
    await flush(40)
    click('[data-testid="stone-style-row-51"]')
    await flush()
    expect(q('[data-testid="stone-cell-stn-j51"]')).toBeDefined()
    expect(document.querySelector('[data-testid="stone-cell-stn-a51"]')).toBeNull()
  })
})

describe('StonePicker 选中产出（S5.1 核心——StonePick 契约）', () => {
  it('点击单元格：onPick 收 StonePick 契约对象（schema parse 守门）；摘要+清选', async () => {
    const { store, picks } = await mountPicker()
    click('[data-testid="stone-style-row-51"]')
    await flush()
    click('[data-testid="stone-cell-stn-j51"]')
    await flush()
    expect(picks).toHaveLength(1)
    // 契约：结构化引用（不内嵌贴图数据）
    expect(() => StonePickSchema.parse(picks[0]!.pick)).not.toThrow()
    expect(picks[0]!.pick).toEqual({
      resourceId: 'stn-j51',
      sku: 'J51',
      supplier: 'yuhang',
      sizeMm: 2,
      colorHex: '#FFFFF0',
    })
    expect(picks[0]!.cell.resourceId).toBe('stn-j51')
    // 选中态：对勾角标+摘要条
    expect(q('[data-testid="stone-cell-check-stn-j51"]')).toBeDefined()
    expect(q('[data-testid="stone-selected-summary"]').textContent).toContain('yuhang/J51')
    expect(q('[data-testid="stone-selected-summary"]').textContent).toContain('#FFFFF0')
    // gemshapeRef 富集后摘要携带（get 异步回填 store.selectedPick）
    expect(q('[data-testid="stone-selected-summary"]').textContent).toContain('2mm')
    click('[data-testid="stone-selected-clear"]')
    await flush()
    expect(document.querySelector('[data-testid="stone-selected-summary"]')).toBeNull()
    expect(store.selectedPick).toBeNull()
  })

  it('gemshapeRef 富集：get 回填后 store.selectedPick 携带（onPick 即时值仍契约合法）', async () => {
    const { store, picks } = await mountPicker({
      gets: { 'stn-j51': { resourceId: 'stn-j51', state: 'resolved', gemshapeRef: 'gem-round-2' } },
    })
    click('[data-testid="stone-style-row-51"]')
    await flush()
    click('[data-testid="stone-cell-stn-j51"]')
    // 即时值（无 gemshapeRef）——schema 本就 optional
    expect(() => StonePickSchema.parse(picks[0]!.pick)).not.toThrow()
    expect(picks[0]!.pick.gemshapeRef).toBeUndefined()
    await flush()
    expect(store.selectedPick?.gemshapeRef).toBe('gem-round-2')
    expect(q('[data-testid="stone-selected-summary"]').textContent).toContain('gem-round-2')
  })

  it('引用四态缺失标注：blob-missing/soft-deleted 显式呈现，选中不阻断', async () => {
    await mountPicker({
      gets: { 'stn-j51': { resourceId: 'stn-j51', state: 'blob-missing' } },
    })
    click('[data-testid="stone-style-row-51"]')
    await flush()
    click('[data-testid="stone-cell-stn-j51"]')
    await flush()
    expect(q('[data-testid="stone-ref-state-stn-j51"]').textContent).toContain('贴图缺失')
    expect(q('[data-testid="stone-selected-summary"]')).toBeDefined()
  })
})

describe('StonePicker ΔE 邻近推荐（S5.2）', () => {
  it('hex 目标色提交：推荐面板渲染 ΔE 升序+ΔE 徽标+客户端排序标注', async () => {
    const { source } = await mountPicker()
    type('[data-testid="stone-recommend-input"]', '#FFFFF0')
    submit('[data-testid="stone-recommend-form"]')
    await flush()
    expect(source.calls.at(-1)!.nearColor).toEqual([255, 255, 240])
    expect(q('[data-testid="stone-recommend"]')).toBeDefined()
    // 协议标注（P3.2 接线判定——报告注明项）
    expect(q('[data-testid="stone-recommend"]').textContent).toContain('客户端排序')
    // ΔE 升序：首屏象牙白三变体（平局稳定序）在前
    const firstIds = Array.from(document.querySelectorAll('[data-testid="stone-recommend"] [data-testid^="stone-delta-e-"]'))
      .slice(0, 3)
      .map((el) => el.getAttribute('data-testid')!.replace('stone-delta-e-', ''))
      .sort()
    expect(firstIds).toEqual(['stn-a51', 'stn-b51', 'stn-j51'])
    expect(q('[data-testid="stone-delta-e-stn-j51"]').textContent).toContain('ΔE')
    // 清除回表单
    click('[data-testid="stone-recommend-clear"]')
    await flush()
    expect(document.querySelector('[data-testid="stone-recommend"]')).toBeNull()
    expect(q('[data-testid="stone-recommend-form"]')).toBeDefined()
  })

  it('非法 hex：显式错误不发查询（不猜测）', async () => {
    const { source } = await mountPicker()
    const before = source.calls.length
    type('[data-testid="stone-recommend-input"]', '白')
    submit('[data-testid="stone-recommend-form"]')
    await flush()
    expect(q('[data-testid="stone-recommend-invalid"]').textContent).toContain('十六进制')
    expect(source.calls.length).toBe(before)
  })

  it('取色找近似：钻面 pipette 以该钻 colorHex 为目标色开面板', async () => {
    await mountPicker()
    click('[data-testid="stone-family-红色系"]')
    await flush()
    click('[data-testid="stone-style-row-60"]')
    await flush()
    click('[data-testid="stone-use-color-stn-j60"]')
    await flush()
    expect(q('[data-testid="stone-recommend"]')).toBeDefined()
    // 正红目标：正红变体（ΔE=0）包揽前二
    const firstIds = Array.from(document.querySelectorAll('[data-testid="stone-recommend"] [data-testid^="stone-delta-e-"]'))
      .slice(0, 2)
      .map((el) => el.getAttribute('data-testid')!.replace('stone-delta-e-', ''))
      .sort()
    expect(firstIds).toEqual(['stn-a60', 'stn-j60'])
  })
})

describe('StonePicker 状态面（S5.3 空/错/接口位）', () => {
  it('空库：显式空态文案（导入指引）', async () => {
    await mountPicker({ cells: [] })
    expect(q('[data-testid="stone-empty"]').textContent).toContain('钻库为空')
  })

  it('错误态→重试恢复', async () => {
    const { source } = await mountPicker()
    source.failNextList('daemon 不可达')
    type('[data-testid="stone-search-input"]', 'J')
    await flush(40)
    expect(q('[data-testid="stone-error"]').textContent).toContain('daemon 不可达')
    click('[data-testid="stone-retry"]')
    await flush()
    expect(document.querySelector('[data-testid="stone-error"]')).toBeNull()
    expect(q('[data-testid="stone-family-白色系"]')).toBeDefined()
  })

  it('S7.5 activeSetId：查询携带+组合投影徽标（真实组合名）+锁定提示条', async () => {
    const source = new MockStonePickerSource({
      activeSets: { 'set-cartoon-a': { setId: 'set-cartoon-a', name: '卡通人物套餐-A', memberResourceIds: ['stn-j51', 'stn-a60'] } },
    })
    const store = new StonePickerStore(source, { searchDebounceMs: 0 })
    const picks: Array<{ pick: StonePick; cell: StoneGridCell }> = []
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StonePicker, { target, props: { store, onPick: (pick, cell) => picks.push({ pick, cell }) } })
    mounted.push(() => {
      unmount(app)
      target.remove()
    })
    await flush()
    expect(document.querySelector('[data-testid="stone-activeset"]')).toBeNull() // 全标准无徽标
    await store.setActiveSetId('set-cartoon-a')
    await flush()
    expect(source.calls.at(-1)!.activeSetId).toBe('set-cartoon-a')
    const badge = q('[data-testid="stone-activeset"]')
    expect(badge.textContent).toContain('组合投影')
    expect(badge.textContent).toContain('卡通人物套餐-A') // 真实组合名（resolveSet 解析）
    expect(q('[data-testid="stone-activeset-lock-hint"]').textContent).toContain('锁定')
    await store.setActiveSetId(null)
    await flush()
    expect(source.calls.at(-1)!.activeSetId).toBeUndefined()
    expect(document.querySelector('[data-testid="stone-activeset"]')).toBeNull()
    expect(document.querySelector('[data-testid="stone-activeset-lock-hint"]')).toBeNull()
  })
})
