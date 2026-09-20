/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-19 Owner 需求] 模板「禁用｜启用」：禁用模板不参与批量生成，×N 计数同步；
 *    [4.3 语义迁移] enabled 归 lab-session 会话 key（gemtpl 文件不含 enabled），持久化往返。
 * 2. [2026-09-19 迁移] 迁移引擎把 legacy enabled 集写入 lab-session（absent = 禁用）。
 * 3. [2026-09-19 回归] Dropzone 预览卡必须随 setReference 重赋值响应式出现（曾因一次性 const 失聪）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import {
  getReference,
  getTasks,
  hydrate,
  resetLabForTests,
  setReference,
  startRun,
  updateSettings,
} from '$lib/stores/lab.svelte'
import {
  getSelectedTemplateAssetId,
  getTemplateAssetIds,
  isEnabledTemplate,
  selectTemplate,
  setEnabledTemplate,
} from '$lib/stores/templates.svelte'
import { LAB_SESSION_KEY } from '$lib/lab/templateMigration'
import { VARIANTS_KEY } from '$lib/persistence/taskStore'
import { resetAssetStoreForTests } from '$lib/persistence/assetStore'
import { installFakeIndexedDB } from './helpers/fakeIndexedDB'
import Dropzone from '../../components/Lab/Dropzone.svelte'

let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
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
        return new Response(new Uint8Array([seed % 251, (seed >> 2) % 241]), {
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
  resetLabForTests() // cancelAll 会持久化上一测试的内存任务——先复位再清，防 hydrate 捞回陈旧任务
  localStorage.clear()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

describe('模板禁用｜启用（lab-session 会话态）', () => {
  beforeEach(async () => {
    const fake = installFakeIndexedDB()
    fake.reset()
    resetAssetStoreForTests() // 全新 IDB 需同步复位 assetStore 模块态（seed 检查 flag 等）
    await hydrate()
  })

  it('默认模板全部启用，setEnabledTemplate 可切换并落 lab-session 往返', () => {
    const ids = getTemplateAssetIds()
    expect(ids.every((id) => isEnabledTemplate(id))).toBe(true)

    setEnabledTemplate(ids[0], false)
    expect(isEnabledTemplate(ids[0])).toBe(false)

    // 持久化往返（语义迁移自 saveVariants/loadVariants roundtrip）：reset+refresh 恢复
    const payload = JSON.parse(localStorage.getItem(LAB_SESSION_KEY) ?? '{}') as { enabledTemplateAssetIds: string[] }
    expect(payload.enabledTemplateAssetIds).not.toContain(ids[0])
  })

  it('禁用的模板不参与批量生成，其余模板不受影响', () => {
    const ids = getTemplateAssetIds()
    setEnabledTemplate(ids[0], false)

    const result = startRun()
    expect(result.ok).toBe(true)
    // 8 条默认（各 2 候选）禁用 1 条 → 14 个任务，且不含被禁模板
    expect(result.enqueued).toBe(14)
    expect(getTasks().every((t) => t.variantId !== ids[0])).toBe(true)
  })

  it('全部禁用时 startRun 拒绝并给出可行动的错误信息', () => {
    for (const id of getTemplateAssetIds()) setEnabledTemplate(id, false)
    const result = startRun()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有启用的模板')
    expect(getTasks().length).toBe(0)
  })

  it('迁移引擎把 legacy enabled 集写入 lab-session：enabled:false 的变体迁移后为禁用', async () => {
    // 重新走一次带 legacy 信封的 hydrate（引擎 session 写入路径）
    resetLabForTests()
    localStorage.clear()
    localStorage.setItem(
      VARIANTS_KEY,
      JSON.stringify({
        v: 2,
        items: [
          { id: 'tpl-boston', name: '波士顿', prompt: 'p', candidates: 2 },
          { id: 'v-off', name: '旧禁用', prompt: 'p', candidates: 2, enabled: false },
        ],
      }),
    )
    await hydrate()

    expect(isEnabledTemplate('ast-tpl-boston')).toBe(true) // 旧数据无 enabled 字段 = 启用
    expect(isEnabledTemplate('ast-tpl-legacy-v-off')).toBe(false) // 显式 false 保持禁用
  })

  it('选中态（手风琴开合）随 session 持久化', () => {
    const ids = getTemplateAssetIds()
    expect(getSelectedTemplateAssetId()).toBe(ids[0]) // 默认首项
    selectTemplate(ids[2])
    const payload = JSON.parse(localStorage.getItem(LAB_SESSION_KEY) ?? '{}') as {
      selectedTemplateAssetId: string | null
    }
    expect(payload.selectedTemplateAssetId).toBe(ids[2])
  })
})

describe('原图预览响应式回归（曾因一次性 const 失聪）', () => {
  beforeEach(() => {
    class OkImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', OkImage)
  })

  it('setReference 重赋值后 Dropzone 立即渲染预览卡', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(Dropzone, { target })

    expect(document.body.querySelector('[data-testid="reference-dropzone"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="reference-card"]')).toBeNull()

    const file = new File([new Uint8Array([1, 2, 3])], 'ref.png', { type: 'image/png' })
    await setReference(file)
    await tick()

    expect(getReference()).not.toBeNull()
    expect(document.body.querySelector('[data-testid="reference-card"]')).not.toBeNull()
    const img = document.body.querySelector('[data-testid="reference-card"] img') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('blob:mock-')

    unmount(app)
    target.remove()
  })
})
