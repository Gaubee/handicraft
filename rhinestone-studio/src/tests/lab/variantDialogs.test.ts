/**
 * [UX-B] 实验室模板复制/删除弹窗——交互面测试：
 * - VariantEditor 组件面：复制 = TemplateForkDialog 表单弹窗（预填源记录全部字段 /
 *   编辑生效落库 / 取消零变更）；删除 = ConfirmDialog（确认软删 / 取消零变更）。
 * - store 面：forkTemplate 覆盖参数（name/prompt/candidates 钳制/caseBinding 解绑）。
 *
 * 依赖链注记：templates/lab store → persistence/labFile（并行占位符代理域）——
 * labFile 中间态期本文件红属外部阻塞，待对方收敛后复跑（钻形面见 assets/gemshapeDialogs.test.ts）。
 * 挂载时机注记：Svelte 5 事件委托在 mount 后首帧 flush 才挂监听——mount 后必须 await tick()
 * 再 dispatch 点击，否则同步点击会丢失（jsdom 实证）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import VariantEditor from '../../components/Lab/VariantEditor.svelte'
import { getProject, listChildNodes, resetAssetStoreForTests } from '$lib/persistence/assetStore'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import {
  forkTemplate,
  getSelectedTemplateAssetId,
  getTemplateAssetIds,
  getTemplateRecord,
} from '$lib/stores/templates.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains, type FakeIndexedDB } from './helpers/fakeIndexedDB'

let fake: FakeIndexedDB
let objectUrlCounter = 0

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

const B64 = 'aGVsbG8='

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
    return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function click(selector: string): void {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`click 目标不存在：${selector}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function setInputValue(selector: string, value: string): void {
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!el) throw new Error(`input 目标不存在：${selector}`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
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
  resetLabForTests()
  localStorage.clear()
  resetToastsForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 实验室模板：复制表单弹窗 + 删除确认（VariantEditor 组件面）
// ---------------------------------------------------------------------------

describe('实验室模板复制/删除弹窗（UX-B）', () => {
  it('复制：点击后弹窗呈现并预填源记录字段（名称+副本/提示词/候选/绑定预览位）', async () => {
    await hydrate()
    const source = getTemplateAssetIds()[0]
    const sourceRecord = getTemplateRecord(source)
    const seeded = getTemplateAssetIds().length

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(VariantEditor, { target })
    await tick() // Svelte 5 事件委托在 mount 后首帧 flush 才挂监听——同步点击会丢失

    click(`[data-testid="template-fork-${source}"]`)
    await waitFor(() => document.querySelector('[data-testid="template-fork-dialog"]') !== null)
    const nameInput = document.querySelector('[data-testid="template-fork-name"]') as HTMLInputElement
    expect(nameInput.value).toBe(`${sourceRecord?.name} 副本`)
    const promptArea = document.querySelector('[data-testid="template-fork-prompt"]') as HTMLTextAreaElement
    expect(promptArea.value).toBe(sourceRecord?.promptBody)
    const candidatesInput = document.querySelector('[data-testid="template-fork-candidates"]') as HTMLInputElement
    expect(candidatesInput.value).toBe(String(sourceRecord?.candidates))
    expect(document.querySelector('[data-testid="template-fork-binding-preview"]')).not.toBeNull()

    unmount(app)
    target.remove()
    expect(getTemplateAssetIds()).toHaveLength(seeded) // 仅打开弹窗：零变更
  })

  it('复制：编辑字段后确认 → 落库新模板（编辑生效）；源模板不动', async () => {
    await hydrate()
    const source = getTemplateAssetIds()[0]
    const seeded = getTemplateAssetIds().length
    const sourcePrompt = getTemplateRecord(source)?.promptBody

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(VariantEditor, { target })
    await tick()

    click(`[data-testid="template-fork-${source}"]`)
    await waitFor(() => document.querySelector('[data-testid="template-fork-name"]') !== null)
    setInputValue('[data-testid="template-fork-name"]', '我的副本模板')
    setInputValue('[data-testid="template-fork-prompt"]', 'forked prompt body')
    setInputValue('[data-testid="template-fork-candidates"]', '5')
    click('[data-testid="template-fork-confirm"]')
    await waitFor(() => getTemplateAssetIds().length === seeded + 1)
    await waitFor(() => getSelectedTemplateAssetId() !== source)

    const created = getSelectedTemplateAssetId()
    expect(created).not.toBeNull()
    expect(getTemplateRecord(created as string)).toMatchObject({
      name: '我的副本模板',
      promptBody: 'forked prompt body',
      candidates: 5,
    })
    const node = await getProject(created as string)
    expect(node?.name).toBe('我的副本模板')
    // 源模板不动
    expect(getTemplateRecord(source)?.promptBody).toBe(sourcePrompt)

    unmount(app)
    target.remove()
  })

  it('复制：编辑后取消 → 零变更（不创建节点）', async () => {
    await hydrate()
    const source = getTemplateAssetIds()[0]
    const seeded = getTemplateAssetIds().length

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(VariantEditor, { target })
    await tick()

    click(`[data-testid="template-fork-${source}"]`)
    await waitFor(() => document.querySelector('[data-testid="template-fork-name"]') !== null)
    setInputValue('[data-testid="template-fork-name"]', '不该存在的副本')
    click('[data-testid="template-fork-cancel"]')
    await waitFor(() => document.querySelector('[data-testid="template-fork-dialog"]') === null)
    expect(getTemplateAssetIds()).toHaveLength(seeded)
    const children = await listChildNodes('sys-templates')
    expect(children.some((n) => n.name === '不该存在的副本')).toBe(false)

    unmount(app)
    target.remove()
  })

  it('删除：确认弹窗呈现 → 取消零变更 / 确认软删入回收站', async () => {
    await hydrate()
    const ids = getTemplateAssetIds()
    const victim = ids[0]

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(VariantEditor, { target })
    await tick()

    // 首项默认展开（选中即开）——其删除钮可达
    click(`[data-testid="template-remove-${victim}"]`)
    await waitFor(() => document.querySelector('[data-testid="template-remove-cancel"]') !== null)
    expect(document.body.textContent).toContain('删除模板')
    expect(document.body.textContent).toContain('回收站')
    click('[data-testid="template-remove-cancel"]')
    await waitFor(() => document.querySelector('[data-testid="template-remove-cancel"]') === null)
    expect(getTemplateAssetIds()).toContain(victim) // 取消 = 零变更

    click(`[data-testid="template-remove-${victim}"]`)
    await waitFor(() => document.querySelector('[data-testid="template-remove-confirm"]') !== null)
    click('[data-testid="template-remove-confirm"]')
    await waitFor(() => !getTemplateAssetIds().includes(victim))
    const node = await getProject(victim)
    expect(node?.trashedAt).toBeDefined() // 软删（回收站可还原）

    unmount(app)
    target.remove()
  })
})

// ---------------------------------------------------------------------------
// store 面：forkTemplate 覆盖参数（弹窗确认的落库口径）
// ---------------------------------------------------------------------------

describe('forkTemplate 覆盖参数（UX-B）', () => {
  it('overrides 全字段生效：name/prompt/candidates 钳制/caseBinding 解绑；缺省沿源值', async () => {
    await hydrate()
    const source = getTemplateAssetIds()[0]
    const sourceRecord = getTemplateRecord(source)
    expect(sourceRecord?.caseBinding).not.toBeNull() // seed 物化后恒有绑定（解绑覆盖可辨）

    const forked = await forkTemplate(source, {
      name: '覆盖名',
      promptBody: 'overridden prompt',
      candidates: 99, // 钳制到 8
      caseBinding: null,
    })
    expect(forked).not.toBeNull()
    const record = getTemplateRecord(forked as string)
    expect(record).toMatchObject({
      name: '覆盖名',
      promptBody: 'overridden prompt',
      candidates: 8,
      caseBinding: null,
    })

    // 缺省（空对象）沿旧行为：「原名 副本」+ 绑定随带
    const forked2 = await forkTemplate(source)
    const record2 = getTemplateRecord(forked2 as string)
    expect(record2?.name).toBe(`${sourceRecord?.name} 副本`)
    expect(record2?.caseBinding).toEqual(sourceRecord?.caseBinding ?? null)
  })
})
