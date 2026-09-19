/*
 * EffectRefControl Dialog 上传区 Tabs 化（[Owner 2026-09-19 裁决]：
 * 拼接模式原图必选 + 上传入口 Tabs 组织）：
 * - 三 tab（拼接合成 / 单张案例 / 粘贴链接）渲染与默认选中（Dialog 打开重置到拼接合成）
 * - tab 切换清空其他模式半成品暂存（拼接双文件位暂存即选即清，无「选原图等配套」双步交互）
 * - 拼接缺任一文件：不触发物化（无入库 / 无绑定），文案提示「还需选择{原图|效果图}」
 * - 两图齐：自动合成绑定（jsdom 无 2D → 降级 single + degraded toast）
 * - [从素材库选] 是选库内资产非上传：独立按钮位于 tab 组外
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import EffectRefControl from '../../components/Lab/EffectRefControl.svelte'
import { hydrate, resetLabForTests, updateSettings } from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import { listChildNodes, resetAssetStoreForTests, type AssetImage } from '$lib/persistence/assetStore'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { drainFakeIndexedDBChains, installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

let fake: FakeIndexedDB
let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  resetAssetStoreForTests()
  resetToastsForTests()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:dialog-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  // jsdom 的 Image 不解码：桩成可加载（naturalWidth=64）——预处理走「解码不可用回退原文件」，
  // 物化管线 loadDrawable 有尺寸、compose 因无 2D 上下文返 null 走降级 single
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
  // hydrate 的 seed 物化需要 /presets/ 图源（node fetch 拉不动相对路径）
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.startsWith('/presets/')) {
        const seed = [...u].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
        return new Response(new Blob([new Uint8Array([seed % 251, (seed >> 2) % 241, (seed >> 4) % 239])], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }),
  )
  resetLabForTests()
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  // bits-ui Dialog 卸载的 portal 清理存在 jsdom 残留：测试间清空 body，防陈旧弹层污染查询
  document.body.innerHTML = ''
})

function png(bytes: number[], name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

function click(selector: string): void {
  const el = document.querySelector(selector)
  expect(el, `${selector} 应存在`).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function setFiles(selector: string, file: File): void {
  const input = document.querySelector(selector) as HTMLInputElement | null
  expect(input, `${selector} 应存在`).not.toBeNull()
  Object.defineProperty(input!, 'files', { value: [file], configurable: true })
  input!.dispatchEvent(new Event('change', { bubbles: true }))
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? ''
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface MountedControl {
  templateId: string
  unmount: () => void
}

/** 挂载一个空绑定模板的 EffectRefControl（聚焦上传区交互，非绑定预览）。 */
async function mountControl(): Promise<MountedControl> {
  await hydrate()
  const templateId = getTemplateAssetIds()[0]
  submitTemplateField(templateId, { caseBinding: null })
  await whenTemplatesIdle()
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(EffectRefControl, {
    target,
    props: { templateAssetId: templateId, caseBinding: null },
  })
  return {
    templateId,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function openDialog(): Promise<void> {
  click('[data-testid="effect-ref-open"]')
  await flush()
}

async function uploadsCount(): Promise<number> {
  const nodes = await listChildNodes('sys-uploads')
  return nodes.filter((n): n is AssetImage => n.type === 'image').length
}

describe('Dialog 上传区 Tabs：渲染与 IA', () => {
  it('三 tab 渲染（拼接合成/单张案例/粘贴链接），默认选中「拼接合成」，其余 content 隐藏', async () => {
    const m = await mountControl()
    await openDialog()

    const labels = ['pair', 'single', 'url'].map(
      (tab) => document.querySelector(`[data-testid="effect-ref-tab-${tab}"]`)?.textContent?.trim(),
    )
    expect(labels).toEqual(['拼接合成', '单张案例', '粘贴链接'])

    expect(document.querySelector('[data-testid="effect-ref-upload-pair"]')?.getAttribute('data-state')).toBe('active')
    expect(document.querySelector('[data-testid="effect-ref-upload-single"]')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('[data-testid="effect-ref-url-form"]')?.hasAttribute('hidden')).toBe(true)

    m.unmount()
  })

  it('[从素材库选] 不进 tabs：独立按钮位于 tab 组结构之外', async () => {
    const m = await mountControl()
    await openDialog()

    const lib = document.querySelector('[data-testid="effect-ref-pick-library"]')
    expect(lib).not.toBeNull()
    expect(lib!.closest('[data-testid="effect-ref-upload-tabs"]')).toBeNull()

    m.unmount()
  })
})

describe('tab 切换清暂存 + 打开重置', () => {
  it('拼接暂存图 A → 切单张 → 切回拼接：A 已清，缺件提示复位（双步暂存交互删除）', async () => {
    const m = await mountControl()
    await openDialog()

    setFiles('[data-testid="effect-ref-pair-src-input"]', png([1], 'a.png'))
    await flush()
    expect(text('[data-testid="effect-ref-pair-src-name"]')).toContain('a.png')
    expect(text('[data-testid="effect-ref-pair-hint"]')).toBe('还需选择效果图')

    click('[data-testid="effect-ref-tab-single"]')
    await flush()
    click('[data-testid="effect-ref-tab-pair"]')
    await flush()

    expect(text('[data-testid="effect-ref-pair-src-name"]')).toBe('未选择')
    expect(text('[data-testid="effect-ref-pair-hint"]')).not.toContain('还需选择')

    m.unmount()
  })

  it('切到粘贴链接输入草稿 → 关闭重开：tab 重置到「拼接合成」且草稿清空', async () => {
    const m = await mountControl()
    await openDialog()

    click('[data-testid="effect-ref-tab-url"]')
    await flush()
    const resInput = document.querySelector('[data-testid="effect-ref-url-form"] input[placeholder="https://…/rhinestone.jpg"]') as HTMLInputElement | null
    expect(resInput).not.toBeNull()
    resInput!.value = 'https://cdn.example.com/r.jpg'
    resInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(document.querySelector('[data-testid="effect-ref-url-form"]')?.getAttribute('data-state')).toBe('active')

    click('[data-slot="dialog-close"]')
    await flush()
    await openDialog()

    expect(document.querySelector('[data-testid="effect-ref-upload-pair"]')?.getAttribute('data-state')).toBe('active')
    expect(document.querySelector('[data-testid="effect-ref-url-form"]')?.hasAttribute('hidden')).toBe(true)
    // 草稿已随重开清空（Dialog 重开重挂内容，重查当前 input；content 虽隐藏仍在 DOM）
    const resInputAfter = document.querySelector('[data-testid="effect-ref-url-form"] input[placeholder="https://…/rhinestone.jpg"]') as HTMLInputElement | null
    expect(resInputAfter).not.toBeNull()
    expect(resInputAfter!.value).toBe('')

    m.unmount()
  })
})

describe('拼接模式：两图缺一不可（原图必选裁决）', () => {
  it('缺任一文件不触发物化：无入库、无绑定、无 busy，提示「还需选择效果图」', async () => {
    const m = await mountControl()
    await openDialog()

    setFiles('[data-testid="effect-ref-pair-src-input"]', png([1], 'src.png'))
    await flush(60)

    expect(text('[data-testid="effect-ref-pair-hint"]')).toBe('还需选择效果图')
    expect(document.querySelector('[data-testid="effect-ref-busy"]')).toBeNull()
    expect(getTemplateRecord(m.templateId)?.caseBinding).toBeNull()
    expect(await uploadsCount()).toBe(0)
    expect(getToasts()).toHaveLength(0)

    m.unmount()
  })

  it('两图齐 → 自动合成绑定（jsdom 降级 single + degraded toast），sys-uploads 增一资产', async () => {
    const m = await mountControl()
    await openDialog()

    setFiles('[data-testid="effect-ref-pair-src-input"]', png([1], 'src.png'))
    await flush()
    setFiles('[data-testid="effect-ref-pair-res-input"]', png([2, 2], 'res.png'))
    await waitFor(() => getTemplateRecord(m.templateId)?.caseBinding != null)

    expect(getTemplateRecord(m.templateId)?.caseBinding).toEqual({
      assetId: expect.stringMatching(/^ast-/),
      caseLayout: 'single', // jsdom 无 2D 上下文 → 合成降级（真机由走查验证）
    })
    expect(await uploadsCount()).toBe(1)
    expect(getToasts().some((t) => t.message.includes('自动合成不可用'))).toBe(true)

    m.unmount()
  })
})
