/**
 * 〔WYSIWYG 2026-09-21，enforce-lab-prompt-wysiwyg〕发起区终稿预览测试（What Changes 6）。
 *
 * - RunBar「最终请求提示词」可展开预览：逐可用模板一条（名称 × 候选数 + 替换后全文），
   懒构建（首开物化）；
 * - **同源断言**：预览全文与实际发送的请求提示词逐字节相等——runStage 派发组装与
 *   buildFinalPromptPreviews 消费同一 composeDrillPrompt 与同一选项形态（覆盖 ?? auto
 *   片段）；对照矩阵覆盖 案例绑定（seed 模板）/水钻开/蓝图开 的组合形态；
 * - 公理面：裸模板（无占位符正文）预览 = promptBody 逐字节。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

import { resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import {
  buildFinalPromptPreviews,
  getTasks,
  hydrate,
  resetLabForTests,
  setReference,
  startRun,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  getTemplateAssetIds,
  getTemplateRecord,
  setEnabledTemplate,
  submitTemplateField,
  whenTemplatesIdle,
} from '$lib/stores/templates.svelte'
import RunBar from '../../components/Lab/RunBar.svelte'
import { installFakeIndexedDB, drainFakeIndexedDBChains } from './helpers/fakeIndexedDB'

beforeEach(async () => {
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
  await runAssetMigration()
})

afterEach(async () => {
  await whenTemplatesIdle().catch(() => undefined)
  await drainFakeIndexedDBChains()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = (): void => {
      if (condition()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor 超时'))
      setTimeout(check, 10)
    }
    check()
  })
}

async function mountRunBar(): Promise<{ target: HTMLDivElement; teardown: () => void }> {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(RunBar, { target })
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

async function openPreview(target: HTMLDivElement): Promise<NodeListOf<HTMLElement>> {
  ;(target.querySelector('[data-testid="final-prompt-preview-toggle"]') as HTMLButtonElement).click()
  await waitFor(() => target.querySelector('[data-testid="final-prompt-preview-entry"]') !== null)
  return target.querySelectorAll('[data-testid="final-prompt-preview-entry"]')
}

describe('终稿预览 UI（RunBar 可展开「最终请求提示词」）', () => {
  it('首模板启用：展开 = 懒构建逐模板条目（名称 × 候选数 + 替换后全文 pre）', async () => {
    await hydrate()
    const first = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
    submitTemplateField(first, { candidates: 1, promptBody: '预览正文' })
    await whenTemplatesIdle()

    const { target, teardown } = await mountRunBar()
    expect(target.querySelector('[data-testid="final-prompt-preview-entry"]')).toBeNull() // 未展开零构建
    const entries = await openPreview(target)
    expect(entries.length).toBe(1)
    expect(entries[0].querySelector('summary')?.textContent).toContain(getTemplateRecord(first)?.name ?? '')
    expect(entries[0].querySelector('summary')?.textContent).toContain('× 1')
    const text = entries[0].querySelector('[data-testid="final-prompt-preview-text"]')?.textContent
    expect(text).toBe('预览正文') // 公理面：无占位符正文逐字节透传

    teardown()
  })

  it('同源断言：预览全文 === 实际发送的请求提示词（案例绑定 seed 模板——task.composedPrompt 逐字节）', async () => {
    await hydrate()
    const first = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
    // seed 模板：案例绑定在 + v2 正文（占位符 + 规则尾）——预览/派发同附图集
    submitTemplateField(first, { candidates: 1 })
    await whenTemplatesIdle()

    const previews = await buildFinalPromptPreviews()
    expect(previews).toHaveLength(1)

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    const task = getTasks()[0]
    expect(task.composedPrompt).toBeDefined()
    expect(previews[0].prompt).toBe(task.composedPrompt) // 与实际发送同源（逐字节）
    // seed v2 正文（占位符 + 规则尾）替换后形态：案例片段进占位符位、规则尾正文原样保留
    expect(task.composedPrompt).not.toContain('【案例参照图提示词】')
    expect(task.composedPrompt).toContain('我上传了一张图片：') // 无用户原图 → 单图附图集形态
    expect(task.composedPrompt).toContain('【贴钻指导规则】：')
  })

  it('同源断言：水钻开 + 占位符（含物化清单与比例锚）——预览 === 请求全文', async () => {
    await hydrate()
    const first = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
    submitTemplateField(first, {
      candidates: 1,
      drillParams: {
        enabled: true,
        specs: ['round-ss10'],
        physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      },
    })
    const body = getTemplateRecord(first)?.promptBody ?? ''
    if (!body.includes('【水钻参数提示词】')) {
      submitTemplateField(first, { promptBody: `${body}\n【水钻参数提示词】` })
    }
    await whenTemplatesIdle()

    const previews = await buildFinalPromptPreviews()
    expect(previews[0].prompt).toContain('【尺寸与钻规格】')
    expect(previews[0].prompt).toContain('画幅物理尺寸 210×148mm。图宽对应 1024px：1mm ≈ 4.9px')

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    expect(previews[0].prompt).toBe(getTasks()[0].composedPrompt) // 同源（逐字节）
  })

  it('同源断言：蓝图开（串行）+ 用户原图——预览 === 请求全文（附图集含原图）', async () => {
    await hydrate()
    const first = getTemplateAssetIds()[0]
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, id === first)
    submitTemplateField(first, { candidates: 1, blueprint: { enabled: true } })
    await whenTemplatesIdle()
    await setReference(new File([new Uint8Array([9])], 'ref.png', { type: 'image/png' }))

    const previews = await buildFinalPromptPreviews()
    // 案例绑定 + 原图：案例片段默认内容按 2 图附图集物化（图序声明进入预览）
    expect(previews[0].prompt).toContain('我上传了2 张图片：')

    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))
    expect(previews[0].prompt).toBe(getTasks()[0].composedPrompt) // 同源（逐字节）
  })
})
