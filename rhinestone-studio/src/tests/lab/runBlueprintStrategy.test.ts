/**
 * 发起面板最小面（RunBar 蓝图策略单选 + 高级选项汇总 chips）+ lab-session form
 * blueprintStrategy 扩展 —— openspec add-lab-drill-params-and-blueprint C 3.2
 * （design §4.3 策略选择层级 / §6.2 发起面板最小面）。
 *
 * 覆盖（tasks 3.2 vitest 口径）：
 * - 无蓝图模板在列 → 策略选择器不出现；启用蓝图模板在列 → 出现且默认串行选中
 * - 策略快照进任务：串行/并行 → startRun 后每个蓝图任务 blueprint={strategy, refs}；
 *   未启用蓝图的模板任务无 blueprint 键（正交）
 * - 并行实验提示行只在并行选中时出现（随机性声明，design §4.1）
 * - 高级选项汇总 chips（只读）：水钻参数/蓝图计数与模板态联动
 * - form 持久化 round-trip：saveLabForm→loadLabForm（新键可选，旧载荷缺席回 serial；
 *   脏值防御视为缺席）
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

import { loadLabForm, saveLabForm } from '$lib/persistence/taskStore'
import { resetAssetStoreForTests } from '$lib/persistence/assetStore'
import {
  getForm,
  getTasks,
  hydrate,
  resetLabForTests,
  startRun,
  updateForm,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  resetTemplatesForTests,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import RunBar from '../../components/Lab/RunBar.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains } from './helpers/fakeIndexedDB'

beforeEach(() => {
  vi.unstubAllGlobals()
  const fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  let objectUrlCounter = 0
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
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
    }),
  )
  localStorage.clear()
  resetLabForTests()
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

async function mountRunBar(): Promise<{ target: HTMLDivElement; teardown: () => void }> {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(RunBar, { target })
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

function q(target: HTMLDivElement, selector: string): HTMLElement {
  const el = target.querySelector(selector)
  if (!el) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

/** seed 后全开蓝图（或指定态）的最常用模板态。 */
function enableBlueprintOnFirstTemplate(refs: string[] = ['ast-ref-1']): void {
  submitTemplateField(getTemplateAssetIds()[0], { blueprint: { enabled: true, refs } })
}

describe('C3.2 策略选择器显隐与默认态', () => {
  it('无蓝图模板在列：选择器与 chips 不出现', async () => {
    await hydrate()
    const { target, teardown } = await mountRunBar()
    expect(target.querySelector('[data-testid="blueprint-strategy"]')).toBeNull()
    expect(target.querySelector('[data-testid="advanced-chips"]')).toBeNull()
    expect(q(target, '[data-testid="run-button"]')).toBeTruthy()
    teardown()
  })

  it('启用蓝图的模板在列：选择器出现、默认串行选中；chips 只读汇总', async () => {
    await hydrate()
    enableBlueprintOnFirstTemplate()
    const firstId = getTemplateAssetIds()[0]
    submitTemplateField(firstId, { drillParams: { enabled: true, specs: ['round-ss10'] } })

    const { target, teardown } = await mountRunBar()
    expect(q(target, '[data-testid="blueprint-strategy"]')).toBeTruthy()
    expect((q(target, '[data-testid="blueprint-strategy-serial"] input') as HTMLInputElement).checked).toBe(true)
    expect(target.querySelector('[data-testid="blueprint-strategy-hint"]')).toBeNull() // 串行默认无随机性声明

    // chips 汇总：1 个水钻 + 1 个蓝图
    expect(q(target, '[data-testid="advanced-chips"]').textContent).toContain('水钻参数 × 1')
    expect(q(target, '[data-testid="advanced-chips"]').textContent).toContain('蓝图 × 1')

    // 切并行：radio 状态翻转 + 随机性声明出现
    q(target, '[data-testid="blueprint-strategy-parallel"] input').click()
    await tick()
    expect((q(target, '[data-testid="blueprint-strategy-parallel"] input') as HTMLInputElement).checked).toBe(true)
    expect(q(target, '[data-testid="blueprint-strategy-hint"]').textContent).toContain('随机性大')

    teardown()
  })
})

describe('C3.2 策略快照进任务（startRun 物化）', () => {
  it('并行选中 → 蓝图任务 blueprint={strategy:parallel, refs}；未启用模板任务无 blueprint 键', async () => {
    await hydrate()
    enableBlueprintOnFirstTemplate()
    setEnabledTemplate(getTemplateAssetIds()[0], true)

    // 默认串行起一批：蓝图任务快照 strategy=serial
    const run1 = startRun()
    expect(run1.ok).toBe(true)
    const blueprintTask1 = getTasks().find((t) => t.templateAssetId === getTemplateAssetIds()[0])
    expect(blueprintTask1?.blueprint).toEqual({ strategy: 'serial', refs: ['ast-ref-1'] })

    // 切并行再起一批：新任务 strategy=parallel（快照按 run 时 form 物化；按批次切片断言）
    updateForm({ blueprintStrategy: 'parallel' })
    expect(getForm().blueprintStrategy).toBe('parallel')
    const taskCountBefore = getTasks().length
    const run2 = startRun()
    expect(run2.ok).toBe(true)
    const batchTasks = getTasks().slice(taskCountBefore)
    expect(batchTasks.length).toBeGreaterThan(0)
    expect(batchTasks.filter((t) => t.blueprint !== undefined).every((t) => t.blueprint?.strategy === 'parallel')).toBe(true)

    // 未启用蓝图的模板任务：无 blueprint 键（正交——其余 seed 模板全未启用蓝图）
    const plainTasks = getTasks().filter((t) => t.templateAssetId !== getTemplateAssetIds()[0])
    expect(plainTasks.length).toBeGreaterThan(0)
    expect(plainTasks.every((t) => t.blueprint === undefined)).toBe(true)
  })

  it('蓝图模板被禁用（不在列）→ 不出现选择器；启用后出现', async () => {
    await hydrate()
    const firstId = getTemplateAssetIds()[0]
    submitTemplateField(firstId, { blueprint: { enabled: true } })
    setEnabledTemplate(firstId, false)

    const { target, teardown } = await mountRunBar()
    expect(target.querySelector('[data-testid="blueprint-strategy"]')).toBeNull()

    setEnabledTemplate(firstId, true)
    await tick()
    expect(q(target, '[data-testid="blueprint-strategy"]')).toBeTruthy()
    teardown()
  })
})

describe('C3.2 lab-session form 持久化（PersistedLabForm 扩展）', () => {
  it('saveLabForm → loadLabForm round-trip：blueprintStrategy 新键可选', () => {
    saveLabForm({ advancedJson: '{}', size: '1024x1024', blueprintStrategy: 'parallel' })
    expect(loadLabForm()).toEqual({ advancedJson: '{}', size: '1024x1024', blueprintStrategy: 'parallel' })

    // 旧载荷（无新键）→ 缺席
    saveLabForm({ advancedJson: '', size: '1024x1024' })
    expect(loadLabForm()?.blueprintStrategy).toBeUndefined()

    // 脏值防御：非 serial/parallel 视为缺席
    localStorage.setItem(
      'rhinestone-studio:form',
      JSON.stringify({ advancedJson: '', size: '1024x1024', blueprintStrategy: 'bogus' }),
    )
    expect(loadLabForm()?.blueprintStrategy).toBeUndefined()
  })
})
