/**
 * 高级选项区（TemplateAdvancedOptions + templates store drillParams/blueprint 提交面）
 * —— openspec add-lab-drill-params-and-blueprint C 3.1（design §1.1/§6.1）。
 *
 * 覆盖（tasks 3.1 vitest 口径）：
 * - 开关态持久：enabled=false 数据保留（关灯不丢清单）+ 落盘 round-trip（parseGemtpl 读回）
 * - 双宿主（手风琴/RightSheet 同 record 互见）：两个组件实例一处提交另一处实时反映
 * - 写入门（advancedOptions validate）：重复 specKey / enabled 空清单 / refs>2 / physical
 *   非正数 → 拒写（record 零变化 + toast），不入写队列
 * - 规格选择器（桩目录 gemCatalogService mock）：选项来自 mock 目录、选中入清单行
 * - 画幅物理尺寸可选声明：勾选默认落 declared、宽高 change 提交、非法输入不提交
 * - 软上限警告（>8 只警告不阻断，文案单一真源 = advancedOptions）
 * - 蓝图区：开关 + Beta 徽标 + refs 槽骨架（API 写入 refs → 槽位展示/移除；[4.1] refs 落盘往返）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

import AssetPickerHost from '../../components/Assets/AssetPickerHost.svelte'
import * as library from '$lib/assets/library.svelte'
import { parseGemtpl } from '$lib/persistence/labFile'
import { GEMSHAPE_SEEDS } from '$lib/engine'
import { getImageBlob } from '$lib/persistence/imageStore'
import { getProject, ingestAsset, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { hydrate, resetLabForTests, getTasks, startRun, updateSettings } from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  refreshTemplates,
  resetTemplatesForTests,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import TemplateAdvancedOptions from '../../components/Lab/TemplateAdvancedOptions.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0

/** hydrate 种子默认桩：/presets/ 静态图（每 URL 唯一字节防内容寻址并辙）。 */
function stubSeedFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith('/presets/')) {
      const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
      return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function readTemplateFile(assetId: string) {
  const node = await getProject(assetId)
  if (!node) throw new Error('template node missing')
  const blob = await getImageBlob(node.blobKey)
  if (!blob) throw new Error('template blob missing')
  return parseGemtpl(await blob.text(), { mime: node.mime })
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  class OkImage {
    naturalWidth = 64
    naturalHeight = 64
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', OkImage)
  vi.stubGlobal('fetch', stubSeedFetch())
  localStorage.clear()
  resetLabForTests() // cancelAll 会把上一测试的内存任务持久化——先复位再清 localStorage，防 hydrate 捞回陈旧任务
  localStorage.clear()
  resetToastsForTests()
  // [4.2] 真源目录 = sys-shapes .gemshape 资产：seed 排干保确定性（hydrate 内 void 迁移不 await）
  await runAssetMigration()
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

/** mount 一个高级选项区（默认挂 document.body 的隔离容器）。 */
async function mountOptions(assetId: string): Promise<{ target: HTMLDivElement; teardown: () => void }> {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(TemplateAdvancedOptions, { target, props: { templateAssetId: assetId } })
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

function q(target: HTMLDivElement, selector: string): HTMLElement {
  const el = target.querySelector(selector)
  if (!el) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

/** [4.2] 真源目录 IDB 异步 hydrate：等待条件成立（选择器选项填充等）。 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 拨 Switch（bits-ui root 是 button，click 切换 checked）。 */
async function clickSwitch(target: HTMLDivElement, testid: string): Promise<void> {
  q(target, `[data-testid="${testid}"]`).click()
  await tick()
}

describe('C3.1 高级选项区：开关态持久（enabled=false 数据保留）', () => {
  it('空清单拨开 → 表单展开但不落非法键；首规格入单即点亮；关灯保留清单并落盘', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountOptions(id)

    // 1) 空清单拨开：表单展开（pendingOpen），record 未落 enabled=true
    await clickSwitch(target, 'drill-switch')
    expect(q(target, '[data-testid="drill-form"]')).toBeTruthy()
    expect(getTemplateRecord(id)?.drillParams).toBeUndefined()

    // 2) 选择器选首规格 → enabled=true + specs 入单（pendingOpen 收敛）
    const select = q(target, '[data-testid="drill-spec-add"]') as HTMLSelectElement
    await waitFor(() => select.options.length > 1) // 真源目录 IDB hydrate
    const option = select.options[1]
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams).toEqual({ enabled: true, specs: [option.value] })
    expect(q(target, '[data-testid="drill-spec-row"]').getAttribute('data-spec-key')).toBe(option.value)

    // 3) 加第二个规格（数组序 = 编号序）
    const select2 = q(target, '[data-testid="drill-spec-add"]') as HTMLSelectElement
    const option2 = select2.options[1]
    select2.value = option2.value
    select2.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.specs).toEqual([option.value, option2.value])

    // 4) 关灯：enabled=false + 数据保留
    await clickSwitch(target, 'drill-switch')
    expect(getTemplateRecord(id)?.drillParams).toEqual({
      enabled: false,
      specs: [option.value, option2.value],
    })

    // 5) 落盘 round-trip：磁盘 drillParams 保留（关灯态）
    await whenTemplatesIdle()
    const file = await readTemplateFile(id)
    expect(file.drillParams).toEqual({ enabled: false, specs: [option.value, option2.value] })

    teardown()
  })

  it('移除至空清单：enabled 退 false（空态合法）；再拨开重选', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss10'] } })
    const { target, teardown } = await mountOptions(id)

    q(target, '[data-testid="drill-spec-remove"]').click()
    await tick()
    expect(getTemplateRecord(id)?.drillParams).toEqual({ enabled: false, specs: [] })

    teardown()
  })
})

describe('C3.1 双宿主（手风琴/RightSheet 同 record 互见）', () => {
  it('两个实例挂同一模板：宿主 A 提交，宿主 B 实时反映', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const a = await mountOptions(id)
    const b = await mountOptions(id)

    // A 宿主：拨开 + 选首规格（点亮开关）
    await clickSwitch(a.target, 'drill-switch')
    const select = q(a.target, '[data-testid="drill-spec-add"]') as HTMLSelectElement
    await waitFor(() => select.options.length > 1) // 真源目录 IDB hydrate
    select.value = select.options[1].value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    // B 宿主：开关点亮 + 清单行互见（同 $state record，不等写盘；drillOn 态才渲染清单区）
    expect(b.target.querySelector('[data-testid="drill-form"]')).toBeTruthy()
    expect(q(b.target, '[data-testid="drill-spec-row"]')).toBeTruthy()
    expect(q(b.target, '[data-testid="drill-specs-count"]').textContent).toContain('1 规格')

    a.teardown()
    b.teardown()
  })
})

describe('C3.1 写入门（advancedOptions validate → 拒写 + toast）', () => {
  it('重复 specKey / enabled 空清单 / refs>2 / physical 非正数：record 零变化 + toast', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss10'] } })
    const before = getTemplateRecord(id)?.drillParams

    resetToastsForTests()
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss10', 'round-ss10'] } })
    expect(getTemplateRecord(id)?.drillParams).toEqual(before)
    expect(getToasts().some((t) => t.message.includes('不重复的 specKey'))).toBe(true)

    resetToastsForTests()
    submitTemplateField(id, { drillParams: { enabled: true, specs: [] } })
    expect(getTemplateRecord(id)?.drillParams).toEqual(before)
    expect(getToasts().some((t) => t.message.includes('至少 1 条'))).toBe(true)

    resetToastsForTests()
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['a1', 'a2', 'a3'] } })
    expect(getTemplateRecord(id)?.blueprint).toBeUndefined()
    expect(getToasts().some((t) => t.message.includes('至多 2 张蓝图参考图'))).toBe(true)

    resetToastsForTests()
    submitTemplateField(id, {
      drillParams: { enabled: true, specs: ['round-ss10'], physical: { widthMm: -1, heightMm: 100, anchorSource: 'declared' } },
    })
    expect(getTemplateRecord(id)?.drillParams).toEqual(before)
    expect(getToasts().some((t) => t.message.includes('正数'))).toBe(true)

    // 拒写不入队列：idle 后磁盘无高级选项键
    await whenTemplatesIdle()
    const file = await readTemplateFile(id)
    expect(file.drillParams?.physical).toBeUndefined()
    expect(file.blueprint).toBeUndefined()
  })

  it('合法 refs 提交通过门（≤2 去重）；refs 随 blueprint 落盘（[4.1] labFile 键位补齐）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['ast-1', 'ast-2'] } })
    expect(getTemplateRecord(id)?.blueprint).toEqual({ enabled: true, refs: ['ast-1', 'ast-2'] })

    await whenTemplatesIdle()
    const file = await readTemplateFile(id)
    expect(file.blueprint).toEqual({ enabled: true, refs: ['ast-1', 'ast-2'] }) // [4.1] refs 落盘
  })
})

describe('4.2 规格选择器（真源目录 = sys-shapes .gemshape 资产 hydrate）', () => {
  it('目录选项来自真源（GEMSHAPE_SEEDS 声明序，五形）；missing specKey 清单行显示「规格缺失」角标', async () => {
    await runAssetMigration() // sys-shapes seed（hydrate 内 void 迁移不 await——显式排干保确定性）
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss6'] } })
    const { target, teardown } = await mountOptions(id)
    await tick()
    // 真源 hydrate 是 IDB 异步链：排干事件循环让 specViews 解析落定（占位分支与解析分支分离断言）
    await new Promise((resolve) => setTimeout(resolve, 0))

    const select = q(target, '[data-testid="drill-spec-add"]') as HTMLSelectElement
    // 选项：占位项 + 剩余档位（round-ss6 已入单不重复出现 → 总数恰 = 全集数；GEMSHAPE_SEEDS 声明序）
    expect(select.options.length).toBe(GEMSHAPE_SEEDS.length)
    expect(select.options[1].value).toBe(GEMSHAPE_SEEDS[1].specKey)
    // 五形目录：异形档入列（square/drop/heart/marquise mm 档）
    const optionKeys = Array.from(select.options).map((o) => o.value)
    expect(optionKeys).toContain('square-3')
    expect(optionKeys).toContain('marquise-5')

    // 目录解析展示：真源条目 → 形状/尺寸可见
    expect(q(target, '[data-testid="drill-spec-row"]').textContent).toContain('SS6')

    // missing specKey（API 注入）：⚠ 规格缺失警告角标（编辑不阻断；发起 fail-fast 归 4.3）
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss6', 'custom-xyz'] } })
    await tick()
    const rows = target.querySelectorAll('[data-testid="drill-spec-row"]')
    expect(rows[1].textContent).toContain('规格缺失')
    expect(q(target, '[data-testid="drill-spec-missing"]')).toBeTruthy()

    teardown()
  })
})

describe('C3.1 画幅物理尺寸（[lab-ux 5] 必选——勾选退役）', () => {
  it('未声明：空输入 + 必填提示；两值合法 → 提交 declared；非法输入不提交并提示', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: true, specs: ['round-ss10'] } })
    const { target, teardown } = await mountOptions(id)

    // 未声明：输入空（placeholder 示例）+ 必填标记与提示
    const width = q(target, '[data-testid="drill-physical-w"]') as HTMLInputElement
    expect(width.value).toBe('')
    expect(q(target, '[data-testid="drill-physical-label"]').textContent).toContain('必填')
    expect(q(target, '[data-testid="drill-physical-required"]')).toBeTruthy()
    expect(target.querySelector('[data-testid="drill-physical-declare"]')).toBeNull() // 勾选退役

    // 宽填 210（高未填）→ 填写中不提交不算错；高补 148 → 两值齐提交 declared
    width.value = '210'
    width.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.physical).toBeUndefined()
    expect(target.querySelector('[data-testid="drill-physical-error"]')).toBeNull()
    const height = q(target, '[data-testid="drill-physical-h"]') as HTMLInputElement
    height.value = '148'
    height.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.physical).toEqual({
      widthMm: 210,
      heightMm: 148,
      anchorSource: 'declared',
    })
    expect(target.querySelector('[data-testid="drill-physical-required"]')).toBeNull() // 已声明 → 提示消失

    // 宽改为 300 → 提交
    width.value = '300'
    width.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.physical?.widthMm).toBe(300)

    // 非法（0）→ 不提交 + 错误提示
    width.value = '0'
    width.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getTemplateRecord(id)?.drillParams?.physical?.widthMm).toBe(300)
    expect(q(target, '[data-testid="drill-physical-error"]')).toBeTruthy()

    teardown()
  })

  it('[lab-ux 5] startRun fail-fast：水钻开而画幅缺 → 中文错误拦截 + 零任务；蓝图开不拦截', async () => {
    await hydrate()
    updateSettings({ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' })
    const firstId = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === firstId)
    submitTemplateField(firstId, { candidates: 1 })
    submitTemplateField(firstId, { drillParams: { enabled: true, specs: ['round-ss10'] } })
    await whenTemplatesIdle()

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const blocked = startRun()
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('水钻参数配置需要画幅物理尺寸')
    expect(blocked.error).toContain(getTemplateRecord(firstId)?.name ?? '')
    expect(getTasks()).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    // 补画幅 → 放行
    submitTemplateField(firstId, {
      drillParams: {
        enabled: true,
        specs: ['round-ss10'],
        physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      },
    })
    const ok = startRun()
    expect(ok.ok).toBe(true)
    expect(getTasks().length).toBeGreaterThan(0)

    // 蓝图开而画幅缺（水钻关）→ 不拦截（蓝图不强制）
    const secondId = getTemplateAssetIds()[1] ?? firstId
    submitTemplateField(firstId, { drillParams: { enabled: false, specs: ['round-ss10'], physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' } } })
    submitTemplateField(secondId, { blueprint: { enabled: true } })
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === secondId)
    await whenTemplatesIdle()
    const blueprintOnly = startRun()
    expect(blueprintOnly.ok).toBe(true)
  })

  // [R5.2 走查 P2-3 复核] 走查疑点「红字必填可见而发起仍入队」的语义裁定：空清单拨开是
  // drillPendingOpen **视觉待选态**（表单展开 + 必填提示渲染）——record 未落 enabled=true
  // （validate 门拒写空清单）；startRun fail-fast 读的是**提交面**（record.drillParams），
  // 视觉态不参与拦截——正确放行（模板未带水钻参数，无物化面）。真留空（enabled 已提交而
  // physical 缺）由上一用例拦截。另注：走查所见「画幅自动填 210×148」为输入框 placeholder
  // （210/148）的判读——physical 声明值与 placeholder 判据 = drill-physical-required 可见性。
  it('[P2-3 复核] 空清单拨开（视觉待选态）：必填红字可见而 enabled 未落——startRun 读提交面正确放行', async () => {
    await hydrate()
    updateSettings({ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' })
    const firstId = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === firstId)
    submitTemplateField(firstId, { candidates: 1 })
    await whenTemplatesIdle()

    // 空清单拨开：视觉开（表单 + 必填红字）而 store 零提交
    const { target, teardown } = await mountOptions(firstId)
    await clickSwitch(target, 'drill-switch')
    expect(q(target, '[data-testid="drill-form"]')).toBeTruthy()
    expect(q(target, '[data-testid="drill-physical-required"]')).toBeTruthy()
    expect(getTemplateRecord(firstId)?.drillParams).toBeUndefined()
    teardown()

    const result = startRun()
    expect(result.ok).toBe(true) // 提交面无水钻参数——不受视觉待选态影响
    expect(getTasks().length).toBeGreaterThan(0) // 任务入队（stage 发起异步——走查所见形态）
  })
})

describe('C3.1 软上限警告与蓝图区骨架', () => {
  it('specs > 8：警告出现但不阻断提交', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const nineSpecs = ['round-ss6', 'round-ss8', 'round-ss10', 'round-ss12', 'round-ss14', 'round-ss16', 'round-ss18', 'round-ss20', 'round-ss22']
    submitTemplateField(id, { drillParams: { enabled: true, specs: nineSpecs } })
    const { target, teardown } = await mountOptions(id)

    expect(target.querySelectorAll('[data-testid="drill-spec-row"]')).toHaveLength(9)
    expect(q(target, '[data-testid="drill-warning"]').textContent).toContain('9 条')

    teardown()
  })

  it('蓝图开关 + Beta 徽标 + refs 槽（计数/移除/选择按钮 disabled 骨架）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    const { target, teardown } = await mountOptions(id)

    // 初始关：表单不展开
    expect(target.querySelector('[data-testid="blueprint-form"]')).toBeNull()

    await clickSwitch(target, 'blueprint-switch')
    expect(getTemplateRecord(id)?.blueprint).toEqual({ enabled: true })
    expect(q(target, '[data-testid="blueprint-beta"]').textContent).toContain('Beta')

    // refs API 写入（选择动作归 4.2）：槽位展示 + 移除
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['ast-ref-1', 'ast-ref-2'] } })
    await tick()
    expect(q(target, '[data-testid="blueprint-refs-count"]').textContent?.trim()).toBe('2 / 2')
    expect(target.querySelectorAll('[data-testid="blueprint-ref-row"]')).toHaveLength(2)
    expect((q(target, '[data-testid="blueprint-ref-add"]') as HTMLButtonElement).disabled).toBe(true)

    q(target, '[data-testid="blueprint-ref-remove"]').click()
    await tick()
    expect(getTemplateRecord(id)?.blueprint?.refs).toEqual(['ast-ref-2'])

    teardown()
  })
})

describe('C3.1 读面恢复（刷新 → record 从磁盘恢复高级选项）', () => {
  it('落盘后 refreshTemplates：drillParams/blueprint（含 refs）恢复进 record（[4.1] refs 往返）', async () => {
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { drillParams: { enabled: false, specs: ['round-ss10'], physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' } } })
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['ast-ref-1'] } })
    await whenTemplatesIdle()

    await refreshTemplates()
    const record = getTemplateRecord(id)
    expect(record?.drillParams).toEqual({
      enabled: false,
      specs: ['round-ss10'],
      physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
    })
    expect(record?.blueprint).toEqual({ enabled: true, refs: ['ast-ref-1'] }) // [4.1] refs 随读面恢复
  })
})

// ---------------------------------------------------------------------------
// [4.2] 蓝图参考图选择（AssetPickerHost 接线——App 层单实例协议 open → resolve）
// ---------------------------------------------------------------------------

describe('[lab-ux 4] 蓝图参考图缩略预览', () => {
  it('refs = 缩略图渲染（素材库懒解析 URL）+ 计数；点击缩略开大图预览（id 只进角注）', async () => {
    library.resetLibraryForTests()
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true } })

    const { node } = await ingestAsset({
      blob: new File([new Uint8Array([7, 7, 7, 7])], 'bp-thumb.png', { type: 'image/png' }),
      name: 'bp-thumb.png',
      width: 6,
      height: 6,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    await library.ensureLibraryReady()
    submitTemplateField(id, { blueprint: { enabled: true, refs: [node.id] } })

    const { target, teardown } = await mountOptions(id)
    // 缩略解析（library 异步投影）→ img 渲染；计数 1/2
    await waitFor(() => target.querySelector('[data-testid="blueprint-ref-thumb"] img') !== null)
    expect(q(target, '[data-testid="blueprint-refs-count"]').textContent?.trim()).toBe('1 / 2')

    // 点击缩略 → 大图预览 Dialog（body portal）；资产 id 只进角注不做正文
    q(target, '[data-testid="blueprint-ref-thumb"]').click()
    await waitFor(() => document.querySelector('[data-testid="blueprint-ref-preview-img"]') !== null)
    const caption = document.querySelector('[data-testid="blueprint-ref-preview-id"]')
    expect(caption?.textContent).toBe(node.id)

    teardown()
  })

  it('空态引导文案；missing 资产 = 占位图标（不显示裸 id）；移除仍可用', async () => {
    library.resetLibraryForTests()
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true } })
    const { target, teardown } = await mountOptions(id)

    // 空态：引导选择文案
    expect(q(target, '[data-testid="blueprint-ref-empty"]').textContent).toContain('从素材库选')

    // missing 资产（不在素材库）：占位图标态，无裸 id 正文
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['ast-not-in-library'] } })
    await waitFor(() => target.querySelector('[data-testid="blueprint-ref-thumb-missing"]') !== null)
    const row = q(target, '[data-testid="blueprint-ref-row"]')
    expect(row.textContent?.includes('ast-not-in-library')).toBe(false) // id 不做正文（只进 title/alt）
    expect(row.getAttribute('data-asset-id')).toBe('ast-not-in-library')

    // 移除按钮仍可用
    q(target, '[data-testid="blueprint-ref-remove"]').click()
    await tick()
    expect(getTemplateRecord(id)?.blueprint?.refs).toEqual([])

    teardown()
  })
})

describe('4.2 蓝图参考图：从素材库选（AssetPickerHost）', () => {
  /** Dialog 门户挂 document.body——文档级点击（沿 picker-host.mount.test 先例）。 */
  function clickDoc(selector: string): void {
    const el = document.querySelector(selector)
    if (!el) throw new Error(`selector not found: ${selector}`)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  async function flush(ms = 30): Promise<void> {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  it('多选两张 → refs 提交；满 2 张后按钮禁用（BLUEPRINT_REFS_MAX 上限守卫）', async () => {
    library.resetLibraryForTests() // library 模块态跨测试残留（readyPromise 缓存旧库投影）
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true } })

    // 字节各异（内容寻址去重：同字节同库去重会让三文件塌缩成一节点）
    const mkPng = (name: string, seed: number): File =>
      new File([new Uint8Array([seed, seed + 1, seed + 2, seed + 3])], name, { type: 'image/png' })
    const ingested: string[] = []
    for (const [index, name] of ['bp-a.png', 'bp-b.png', 'bp-c.png'].entries()) {
      const { node } = await ingestAsset({
        blob: mkPng(name, index + 1),
        name,
        width: 8,
        height: 8,
        parentId: 'sys-uploads',
        source: 'upload',
      })
      ingested.push(node.id)
    }
    expect(new Set(ingested).size).toBe(3) // 三节点独立
    await library.ensureLibraryReady()

    const hostTarget = document.createElement('div')
    document.body.append(hostTarget)
    const host = mount(AssetPickerHost, { target: hostTarget })
    const { target, teardown } = await mountOptions(id)
    await tick()

    // 第一轮：多选两张 → 确定 → refs = 两张（App 层单例 controller 协议）
    q(target, '[data-testid="blueprint-ref-add"]').click()
    await flush()
    expect(document.querySelector('[data-testid="asset-picker"]')).not.toBeNull()
    for (const assetId of ingested.slice(0, 2)) {
      // 选项渲染等待（library 异步投影 → Host items 派生）
      await waitFor(() => document.querySelector(`[data-testid="picker-item-${assetId}"]`) !== null)
      clickDoc(`[data-testid="picker-item-${assetId}"]`)
      await flush(5)
    }
    clickDoc('[data-testid="picker-confirm"]')
    await flush()
    await whenTemplatesIdle()
    expect(getTemplateRecord(id)?.blueprint?.refs).toEqual(ingested.slice(0, 2))
    expect(q(target, '[data-testid="blueprint-refs-count"]').textContent?.trim()).toBe('2 / 2')

    // 满 2 张 → 按钮禁用（不再开选图器）
    expect((q(target, '[data-testid="blueprint-ref-add"]') as HTMLButtonElement).disabled).toBe(true)

    teardown()
    unmount(host)
    hostTarget.remove()
  })

  it('取消选择 → resolve(null)：refs 零变化（半选不落 record）', async () => {
    library.resetLibraryForTests()
    await hydrate()
    const id = getTemplateAssetIds()[0]
    submitTemplateField(id, { blueprint: { enabled: true, refs: ['ast-keep'] } })

    const { node } = await ingestAsset({
      blob: new File([new Uint8Array([42, 43])], 'bp-x.png', { type: 'image/png' }),
      name: 'bp-x.png',
      width: 4,
      height: 4,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    await library.ensureLibraryReady()

    const hostTarget = document.createElement('div')
    document.body.append(hostTarget)
    const host = mount(AssetPickerHost, { target: hostTarget })
    const { target, teardown } = await mountOptions(id)
    await tick()

    q(target, '[data-testid="blueprint-ref-add"]').click()
    await flush()
    expect(document.querySelector('[data-testid="asset-picker"]')).not.toBeNull()
    await waitFor(() => document.querySelector(`[data-testid="picker-item-${node.id}"]`) !== null)
    clickDoc(`[data-testid="picker-item-${node.id}"]`)
    await flush(5)
    const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '取消')
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await whenTemplatesIdle()
    expect(getTemplateRecord(id)?.blueprint?.refs).toEqual(['ast-keep'])

    teardown()
    unmount(host)
    hostTarget.remove()
  })
})
