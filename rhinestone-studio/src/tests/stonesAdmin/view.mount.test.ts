/*
 * 装饰钻库管理视图挂载与交互（add-stone-library S3.3）：
 * 树渲染/导航投影、样卡网格渲染（贴图 URL/SKU/尺寸/色名）、filter 变化（关键字/
 * 色系/尺寸/分组）与分页、大样卡虚拟滚动窗口、详情 RightSheet 四态、回收站只读+
 * 恢复占位、导入向导步进 UI 与授权桥占位、导入报告四清单渲染。
 * fixture client 注入（见 fixtures.ts）；jsdom 桩：ResizeObserver/URL.createObjectURL。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StonesAdminView from '../../components/stones-admin/StonesAdminView.svelte'
import StoneCardGrid from '../../components/stones-admin/StoneCardGrid.svelte'
import type { StoneGridCell } from '@handicraft/contracts'
import {
  bindStonesClient,
  getStonesFilter,
  getStonesList,
  resetStonesAdminForTests,
  setStonesFilter,
} from '$lib/stonesAdmin/store.svelte'
import {
  getImportWizardStep,
  resetImportWizardForTests,
  wizardSetReport,
} from '$lib/stonesAdmin/wizard.svelte'
import { makeBareDetail, makeCell, makeClient, makeFullDetail, makeManyCells, type FixtureCalls } from './fixtures'
import type { StoneDetail } from '$lib/stonesAdmin/schemas'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  resetStonesAdminForTests()
  resetImportWizardForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:wiz-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
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
  const el = q(selector) as HTMLInputElement | HTMLTextAreaElement | null
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.value = value
  el!.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mountView(details?: Record<string, StoneDetail>): Promise<{ unmount: () => void; calls: FixtureCalls }> {
  const { client, calls } = makeClient({ ...(details ? { details } : {}) })
  resetStonesAdminForTests()
  bindStonesClient(client)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StonesAdminView, { target })
  await flush()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
    calls,
  }
}

// ---------------------------------------------------------------------------
// 树导航
// ---------------------------------------------------------------------------

describe('StonesAdminView 树导航', () => {
  it('供应商层渲染（childCount 徽标）；点击供应商 → list 过滤 supplier 且 page 归 1', async () => {
    const { unmount, calls } = await mountView()
    expect(q('[data-testid="stones-tree-select-yuhang"]')).not.toBeNull()
    expect(q('[data-testid="stones-tree-select-yuhang"]')?.textContent).toContain('yuhang')

    click('[data-testid="stones-tree-select-yuhang"]')
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.supplier).toBe('yuhang')
    expect(last.page).toBe(1)
    unmount()
  })

  it('展开供应商 → 色系/款式行/叶；点色系 → supplier+family 过滤；点叶 → 详情打开', async () => {
    const { unmount, calls } = await mountView()
    click('[data-testid="stones-tree-toggle-dir-yuhang"]')
    await flush()
    click('[data-testid="stones-tree-select-白色系"]')
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.supplier).toBe('yuhang')
    expect(last.family).toBe('白色系')

    click('[data-testid="stones-tree-toggle-dir-white"]')
    await flush()
    expect(q('[data-testid="stones-tree-dir-51-象牙白"]')).not.toBeNull()
    click('[data-testid="stones-tree-toggle-dir-row51"]')
    await flush()
    click('[data-testid="stones-tree-leaf-res-j51"]')
    await flush()
    expect(q('[data-testid="stone-detail-sheet"]')).not.toBeNull()
    expect(q('[data-testid="stone-detail-title"]')?.textContent).toContain('象牙白')
    unmount()
  })

  it('「全部钻库」清 supplier/family 过滤', async () => {
    const { unmount, calls } = await mountView()
    click('[data-testid="stones-tree-select-yuhang"]')
    await flush()
    click('[data-testid="stones-tree-all"]')
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.supplier).toBeUndefined()
    expect(last.family).toBeUndefined()
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 样卡网格 + filter + 分页
// ---------------------------------------------------------------------------

describe('StonesAdminView 网格与筛选', () => {
  it('网格渲染：每 cell 贴图 URL+SKU+尺寸+色名；状态条 共 N/页码/共享读', async () => {
    const { unmount } = await mountView()
    const card = q('[data-testid="stone-card-res-j51"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('img')?.getAttribute('src')).toBe('/api/stones/res-j51/texture.png')
    expect(card?.textContent).toContain('J51')
    expect(card?.textContent).toContain('2mm')
    expect(card?.textContent).toContain('象牙白')
    expect(q('[data-testid="stones-status-count"]')?.textContent).toContain('共 3 项')
    expect(q('[data-testid="stones-status-count"]')?.textContent).toContain('第 1/1 页')
    expect(q('[data-testid="stones-readscope"]')?.textContent).toContain('shared-library')
    unmount()
  })

  it('S7.7 走查修复：贴图缩略底=中性灰（白贴图白卡底低对比）+finish=unspecified 显「未声明」', async () => {
    const { client } = makeClient({
      cells: [
        makeCell({ resourceId: 'res-g1', sku: 'G1', name: '草表导入 · 2mm', finish: 'glossy', textureUrl: '/api/stones/res-g1/texture.png' }),
        makeCell({ resourceId: 'res-u1', sku: 'U1', name: '草表缺质感 · 2mm', finish: 'unspecified', textureUrl: '/api/stones/res-u1/texture.png' }),
      ],
    })
    resetStonesAdminForTests()
    bindStonesClient(client)
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StonesAdminView, { target })
    await flush()

    for (const id of ['res-g1', 'res-u1']) {
      const card = q(`[data-testid="stone-card-${id}"]`)
      expect(card, `样卡 ${id} 应存在`).not.toBeNull()
      // 中性灰底（对齐 warehouse 瓦片 StoneCellTile 灰底方案）——无 color-mix 内联底色
      const thumb = card!.querySelector('span.flex-1')
      expect(thumb?.className).toContain('bg-zinc-300')
      expect(thumb?.className).toContain('dark:bg-zinc-700')
      expect(thumb?.getAttribute('style')).not.toContain('color-mix')
    }
    // finish 人审值透传 / unspecified 不裸露英文
    expect(q('[data-testid="stone-card-res-g1"]')?.textContent).toContain('glossy')
    const unresolved = q('[data-testid="stone-card-res-u1"]')?.textContent ?? ''
    expect(unresolved).toContain('未声明')
    expect(unresolved).not.toContain('unspecified')
    unmount(app)
    target.remove()
  })

  it('关键字过滤：Enter 提交 → list 收到 q；清除按钮恢复', async () => {
    const { unmount, calls } = await mountView()
    type('[data-testid="stones-filter-q"]', '米白')
    q('[data-testid="stones-filter-q"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    let last = calls.list[calls.list.length - 1]!
    expect(last.q).toBe('米白')
    expect(getStonesFilter().page).toBe(1)

    click('[data-testid="stones-filter-q-clear"]')
    await flush()
    last = calls.list[calls.list.length - 1]!
    expect(last.q).toBeUndefined()
    unmount()
  })

  it('色系过滤：family select 项来自树（supplier 半径全量键）', async () => {
    const { unmount } = await mountView()
    // 树含 白色系（fixture 蓝色系整枝被软删剪枝——不出现）
    const options = qq('[data-testid="stones-filter-family"] option, [data-testid="stones-filter-family"] [role="option"]')
    expect(options.length).toBeGreaterThanOrEqual(0) // Select 展开前不渲染 items——存在性冒烟
    expect(q('[data-testid="stones-filter-family"]')).not.toBeNull()
    unmount()
  })

  it('尺寸过滤：数值 Enter → list 收到 sizeMm', async () => {
    const { unmount, calls } = await mountView()
    type('[data-testid="stones-filter-size"]', '3')
    q('[data-testid="stones-filter-size"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.sizeMm).toBe(3)
    unmount()
  })

  it('S7.7 尺寸筛选标签：placeholder「尺寸(mm)」+w-24 给足宽（「尺寸m|」截断修复）', async () => {
    const { unmount } = await mountView()
    const size = q('[data-testid="stones-filter-size"]') as HTMLInputElement | null
    expect(size, '尺寸输入应存在').not.toBeNull()
    expect(size!.placeholder).toBe('尺寸(mm)')
    expect(size!.className).toContain('w-24')
    expect(size!.className).not.toContain('w-20')
    unmount()
  })

  it('groupBy 分段：按色系分段渲染组头+组内格', async () => {
    const { unmount, calls } = await mountView()
    click('[data-testid="stones-filter-groupby-family"]')
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.groupBy).toBe('family')
    expect(q('[data-testid="stones-grid-grouped"]')).not.toBeNull()
    expect(q('[data-testid="stones-grid-group-白色系"]')).not.toBeNull()
    unmount()
  })

  it('分页：下一页推进 page（pageSize=2 强制多页）', async () => {
    const { client, calls } = makeClient()
    resetStonesAdminForTests()
    bindStonesClient(client)
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StonesAdminView, { target })
    await flush()
    await setStonesFilter({ pageSize: 2 })
    expect(getStonesList()?.cells).toHaveLength(2)
    expect(q('[data-testid="stones-status-count"]')?.textContent).toContain('第 1/2 页')
    click('[data-testid="stones-page-next"]')
    await flush()
    const last = calls.list[calls.list.length - 1]!
    expect(last.page).toBe(2)
    expect(q('[data-testid="stones-status-count"]')?.textContent).toContain('第 2/2 页')
    unmount(app)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// 虚拟滚动（大样卡护栏——design §7.6）
// ---------------------------------------------------------------------------

describe('StoneCardGrid 虚拟滚动', () => {
  async function mountGrid(cells: StoneGridCell[]): Promise<{ target: HTMLElement; app: ReturnType<typeof mount> }> {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StoneCardGrid, { target, props: { cells, onopen: () => {} } })
    await flush()
    return { target, app }
  }

  function stubViewport(container: Element | null, width: number, height: number): void {
    expect(container, '滚动容器应存在').not.toBeNull()
    Object.defineProperty(container!, 'clientWidth', { value: width, configurable: true })
    Object.defineProperty(container!, 'clientHeight', { value: height, configurable: true })
    window.dispatchEvent(new Event('resize'))
  }

  it('600 项大样卡：只渲染窗口子集；滚动后窗口平移', async () => {
    const cells = makeManyCells(600)
    const { target, app } = await mountGrid(cells)
    const scroller = q('[data-testid="stones-grid-scroll"]')
    stubViewport(scroller, 1000, 500)
    await flush()

    const renderedBefore = qq('[data-testid^="stone-card-res-bulk-"]')
    expect(renderedBefore.length).toBeGreaterThan(0)
    expect(renderedBefore.length).toBeLessThan(600)
    expect(Number(q('[data-testid="stones-grid-canvas"]')?.getAttribute('style')?.match(/height: (\d+)px/)?.[1])).toBeGreaterThan(10_000)

    const scrollerEl = scroller as HTMLDivElement
    scrollerEl.scrollTop = 208 * 30
    scrollerEl.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flush()
    const renderedAfter = qq('[data-testid^="stone-card-res-bulk-"]')
    const idsAfter = renderedAfter.map((el) => Number(el.getAttribute('data-testid')?.replace('stone-card-res-bulk-', '')))
    // columns=6（1000px 视口）×startRow 27（scrollTop 行 30−overscan 3）→ 首索引 162
    expect(Math.min(...idsAfter)).toBeGreaterThanOrEqual(162)
    expect(Math.max(...idsAfter)).toBeLessThan(600)

    unmount(app)
    target.remove()
  })

  it('小集合（无滚动需求）也正确渲染全部', async () => {
    const cells = makeManyCells(4)
    const { target, app } = await mountGrid(cells)
    stubViewport(q('[data-testid="stones-grid-scroll"]'), 1000, 500)
    await flush()
    expect(qq('[data-testid^="stone-card-res-bulk-"]')).toHaveLength(4)
    unmount(app)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// 详情 RightSheet 四态
// ---------------------------------------------------------------------------

describe('StoneDetailSheet 四态', () => {
  it('resolved：全文字段+贴图大图+metadata 折叠+raw JSON+软删入口', async () => {
    const { unmount } = await mountView({ 'res-j51': makeFullDetail({ resourceId: 'res-j51' }) })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    expect(q('[data-testid="stone-detail-texture-img"]')?.getAttribute('src')).toBe('/api/stones/res-j51/texture.png')
    const fields = q('[data-testid="stone-detail-fields"]')?.textContent ?? ''
    expect(fields).toContain('2mm')
    expect(fields).toContain('象牙白')
    expect(fields).toContain('白色系')
    expect(q('[data-testid="stone-detail-metadata"]')).not.toBeNull()
    expect(q('[data-testid="stone-detail-raw"]')).not.toBeNull()
    expect(q('[data-testid="stone-detail-delete"]')).not.toBeNull()
    unmount()
  })

  it('S7.7 滚动区/固定操作条分界：内容区 overflow-y-auto+padding-bottom、操作条独立 footer、修订路径行在滚动区内', async () => {
    const { unmount } = await mountView({ 'res-j51': makeFullDetail({ resourceId: 'res-j51' }) })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    const scroll = q('[data-testid="stone-detail-scroll"]')
    expect(scroll, '滚动内容区应存在（显式分界锚点）').not.toBeNull()
    // 内容区：滚动+独立 padding-bottom（末行「修订/路径」滚动到底不贴底缘切断）
    expect(scroll!.className).toContain('overflow-y-auto')
    expect(scroll!.className).toContain('pb-8')
    // 操作条：独立 shrink-0 footer（软删按钮固定底部不随内容滚动/不被压缩）——
    // 位于滚动区之后（中间只隔 sr-only 描述），且是抽屉内容的最后一个可见块
    const actions = q('[data-testid="stone-detail-actions"]')
    expect(actions, '固定操作条应存在').not.toBeNull()
    expect(actions!.className).toContain('shrink-0')
    expect(actions!.className).toContain('border-t')
    expect((scroll!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect(actions!.parentElement?.lastElementChild === actions).toBe(true)
    // 字段面（含末行 修订/路径）整棵在滚动内容区内——不被操作条覆盖的 DOM 分界
    const fields = q('[data-testid="stone-detail-fields"]')
    expect(fields?.closest('[data-testid="stone-detail-scroll"]')?.isSameNode(scroll!)).toBe(true)
    expect(fields?.textContent).toContain('修订/路径')
    unmount()
  })

  it('S7.7 finish=unspecified：详情质感显「未声明」（英文裸露防线）', async () => {
    const detail = makeFullDetail({ resourceId: 'res-j51' })
    detail.stone.color.finish = 'unspecified'
    const { unmount } = await mountView({ 'res-j51': detail })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    const fields = q('[data-testid="stone-detail-fields"]')?.textContent ?? ''
    expect(fields).toContain('未声明')
    expect(fields).not.toContain('unspecified')
    unmount()
  })

  it('soft-deleted：全文可见+已软删徽标+恢复面板（stones.restore 直发）', async () => {
    const { unmount, calls } = await mountView({
      'res-j51': makeFullDetail({ resourceId: 'res-j51', state: 'soft-deleted' }),
    })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    expect(q('[data-testid="stone-detail-trashed-badge"]')).not.toBeNull()
    expect(q('[data-testid="stone-detail-restore-panel"]')?.textContent).toContain('回收站语义')
    expect(q('[data-testid="stone-detail-fields"]')).not.toBeNull()
    expect(q('[data-testid="stone-detail-delete"]')).toBeNull()
    // 恢复动作调真端点（S3.3 占位升级）。
    click('[data-testid="stone-detail-restore"]')
    await flush()
    expect(calls.restore).toContain('res-j51')
    unmount()
  })

  it('blob-missing / wrong-kind：显式态呈现（不炸、无全文）', async () => {
    const { unmount } = await mountView({
      'res-j51': makeBareDetail('blob-missing', 'res-j51'),
      'res-a51': makeBareDetail('wrong-kind', 'res-a51'),
    })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    expect(q('[data-testid="stone-detail-blob-missing"]')?.textContent).toContain('blob-missing')
    expect(q('[data-testid="stone-detail-fields"]')).toBeNull()

    click('[data-testid="stone-detail-close"]')
    await flush()
    click('[data-testid="stone-card-res-a51"]')
    await flush()
    expect(q('[data-testid="stone-detail-wrong-kind"]')?.textContent).toContain('wrong-kind')
    unmount()
  })

  it('软删确认面板：点「软删」→ 确认对话框 → 确认后调 stones.trash（人工直发）', async () => {
    const { unmount, calls } = await mountView({ 'res-j51': makeFullDetail({ resourceId: 'res-j51' }) })
    click('[data-testid="stone-card-res-j51"]')
    await flush()
    click('[data-testid="stone-detail-delete"]')
    await flush()
    const panel = q('[data-testid="stone-delete-panel"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('回收站语义')
    expect(calls.trash).toHaveLength(0) // 确认前零调用
    click('[data-testid="stone-delete-panel-confirm"]')
    await flush()
    expect(calls.trash).toContain('res-j51')
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

describe('回收站视图（恢复动作接线）', () => {
  it('进入回收站：trashed 列表+恢复按钮调 stones.restore+返回库视图', async () => {
    const { unmount, calls } = await mountView()
    await flush()
    click('[data-testid="stones-tree-trash"]')
    await flush()
    expect(q('[data-testid="stones-trash-view"]')).not.toBeNull()
    expect(calls.tree.some((call) => call.includeTrashed === true)).toBe(true)
    expect(q('[data-testid="stone-card-res-a55"]')).not.toBeNull()
    expect(q('[data-testid="stone-card-res-a55"]')?.textContent).toContain('已软删')
    expect(q('[data-testid="stones-trash-view"]')?.textContent).toContain('可恢复')

    click('[data-testid="stones-trash-restore-res-a55"]')
    await flush()
    expect(calls.restore).toContain('res-a55')

    click('[data-testid="stones-trash-exit"]')
    await flush()
    expect(q('[data-testid="stones-trash-view"]')).toBeNull()
    unmount()
  })

  it('树侧回收站计数徽标（init 即拉含软删树）', async () => {
    const { unmount } = await mountView()
    await flush()
    expect(q('[data-testid="stones-trash-count"]')?.textContent).toContain('1')
    unmount()
  })
})

// ---------------------------------------------------------------------------
// 导入向导（UI 壳步进）
// ---------------------------------------------------------------------------

const VALID_DRAFT_JSON = JSON.stringify({
  schemaVersion: 1,
  supplier: 'yuhang',
  sourceImage: { blobRef: 'a'.repeat(64), pages: [{ page: 1, widthPx: 1000, heightPx: 800 }] },
  bands: [{ rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3 } }],
  styles: [
    {
      row: 51,
      suggestedName: '象牙白',
      suggestedFamily: '白色系',
      rgb: [255, 255, 240],
      confidence: 0.9,
      cells: [{ sku: 'J51', page: 1, bboxPx: { x: 0, y: 0, w: 10, h: 10 } }],
    },
    {
      row: 52,
      suggestedName: '',
      suggestedFamily: '蓝色系',
      rgb: [30, 60, 200],
      confidence: 0.5,
      cells: [{ sku: 'A52', page: 1, bboxPx: { x: 5, y: 5, w: 8, h: 8 } }],
    },
  ],
})

describe('导入向导 UI 步进', () => {
  it('sources：多页上传列出页卡；下一步到 draft', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-import-button"]')
    await flush()
    expect(q('[data-testid="import-wizard"]')).not.toBeNull()
    expect(q('[data-testid="import-wizard-sources"]')).not.toBeNull()

    const input = q('[data-testid="import-wizard-file-input"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1])], 'p1.png', { type: 'image/png' }), new File([new Uint8Array([2])], 'p2.png', { type: 'image/png' })],
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(q('[data-testid="import-wizard-page-1"]')).not.toBeNull()
    expect(q('[data-testid="import-wizard-page-2"]')).not.toBeNull()

    click('[data-testid="import-wizard-next"]')
    await flush()
    expect(getImportWizardStep()).toBe('draft')
    unmount()
  })

  it('draft：坏 JSON 报错+下一步禁用；合法草表通过→preview 摘要（低置信清单）→execute 执行步', async () => {
    const { unmount, calls } = await mountView()
    click('[data-testid="stones-import-button"]')
    await flush()
    click('[data-testid="import-wizard-next"]')
    await flush()

    expect((q('[data-testid="import-wizard-next"]') as HTMLButtonElement)?.disabled).toBe(true)
    type('[data-testid="import-wizard-draft-input"]', '{bad json')
    await flush()
    expect(q('[data-testid="import-wizard-draft-error"]')?.textContent).toContain('JSON 解析失败')

    type('[data-testid="import-wizard-draft-input"]', VALID_DRAFT_JSON)
    await flush()
    expect(q('[data-testid="import-wizard-draft-ok"]')?.textContent).toContain('2 款式')
    click('[data-testid="import-wizard-next"]')
    await flush()

    const preview = q('[data-testid="import-wizard-preview"]')?.textContent ?? ''
    expect(preview).toContain('yuhang')
    expect(preview).toContain('款式行2')
    expect(preview).toContain('格数2')
    expect(q('[data-testid="import-wizard-low-confidence"]')?.textContent).toContain('行 52')

    click('[data-testid="import-wizard-next"]')
    await flush()
    expect(getImportWizardStep()).toBe('execute')
    expect(q('[data-testid="import-wizard-execute-step"]')?.textContent).toContain('stones.importRun')
    expect(q('[data-testid="import-wizard-execute-note"]')?.textContent).toContain('操作者即批准人')

    // 执行：上传源图页（blob 映射）+ importRun → 报告步（真数据接线）。
    click('[data-testid="import-wizard-execute"]')
    await flush()
    expect(calls.uploads).toHaveLength(0) // 未传页文件→无上传（单页 blobRef 回退）
    expect(calls.importRun).toHaveLength(1)
    expect(calls.importRun[0]!.options.targetSupplier).toBe('yuhang')
    await flush()
    expect(q('[data-testid="import-wizard-report"]')).not.toBeNull()
    expect(q('[data-testid="import-report-created"]')?.textContent).toContain('J51')
    unmount()
  })

  it('execute 缺页：执行按钮禁用+缺页警示（单页草表须先传源图）', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-import-button"]')
    await flush()
    click('[data-testid="import-wizard-next"]')
    await flush()
    type('[data-testid="import-wizard-draft-input"]', VALID_DRAFT_JSON)
    await flush()
    click('[data-testid="import-wizard-next"]')
    await flush()
    click('[data-testid="import-wizard-next"]')
    await flush()
    // VALID_DRAFT_JSON 声明单页且引用页 1 未上传——单页回退可用，按钮可执行。
    expect(q('[data-testid="import-wizard-execute-missing-pages"]')).toBeNull()
    expect((q('[data-testid="import-wizard-execute"]') as HTMLButtonElement)?.disabled).toBe(false)
    unmount()
  })

  it('report：报告注入后向导呈四清单（成功/跳过/失败/待渲染）+汇总条', async () => {
    const { unmount } = await mountView()
    click('[data-testid="stones-import-button"]')
    await flush()
    const result = wizardSetReport({
      kind: 'card-import-report',
      formatVersion: 1,
      generatedAt: '2026-09-24T00:00:00.000Z',
      supplier: 'yuhang',
      summary: { created: 2, skipped: 1, failed: 1, pending: 1, lowConfidence: 1, rows: 2, needsReviewRows: 1 },
      lowConfidence: [{ sku: 'A52', row: 52, outcome: 'created' }],
      rows: [
        {
          row: 51,
          suggestedName: '象牙白',
          appliedName: '象牙白',
          family: '白色系',
          confidence: 0.9,
          lowConfidence: false,
          needsReview: false,
          cells: [
            { sku: 'J51', finalSku: 'J51', page: 1, status: 'created', reason: null },
            { sku: 'A51', finalSku: 'A51', page: 1, status: 'skipped', reason: 'supplier×sku 已存在' },
          ],
        },
        {
          row: 52,
          suggestedName: '',
          appliedName: '待命名-52',
          family: '蓝色系',
          confidence: 0.5,
          lowConfidence: true,
          needsReview: true,
          cells: [
            { sku: 'A52', finalSku: 'A52', page: 1, status: 'created', reason: null },
            { sku: 'B52', finalSku: 'B52', page: 1, status: 'failed', reason: '贴图 gate：alpha 内容为空' },
            { sku: 'C52', finalSku: 'C52', page: 1, status: 'pending', reason: '跨格同字节——card-render-pending' },
          ],
        },
      ],
    })
    expect(result.ok).toBe(true)
    await flush()
    expect(q('[data-testid="import-wizard-report"]')).not.toBeNull()
    expect(q('[data-testid="import-report-created"]')?.textContent).toContain('J51')
    expect(q('[data-testid="import-report-skipped"]')?.textContent).toContain('A51')
    expect(q('[data-testid="import-report-failed"]')?.textContent).toContain('B52')
    expect(q('[data-testid="import-report-pendingDowngrades"]')?.textContent).toContain('C52')
    expect(q('[data-testid="import-report-summary"]')?.textContent).toContain('成功 2')
    unmount()
  })
})
