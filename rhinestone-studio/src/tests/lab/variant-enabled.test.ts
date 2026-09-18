/*
Orthogonal intents (max 3):
1. [2026-09-19 Owner 需求] 变体「禁用｜启用」：禁用变体不参与批量生成，×N 计数同步，持久化往返。
2. [2026-09-19 迁移] 旧持久化数据（无 enabled 字段）加载后视为启用。
3. [2026-09-19 回归] Dropzone 预览卡必须随 setReference 重赋值响应式出现（曾因一次性 const 失聪）。
*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import {
  defaultVariants,
  getReference,
  getTasks,
  getVariants,
  resetLabForTests,
  setReference,
  startRun,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import { loadVariants, saveVariants } from '$lib/persistence/taskStore'
import Dropzone from '../../components/Lab/Dropzone.svelte'

let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  localStorage.clear()
  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

describe('变体禁用｜启用', () => {
  it('默认变体全部启用，updateVariant 可切换并持久化往返', () => {
    const variants = getVariants()
    expect(variants.every((v) => v.enabled)).toBe(true)

    updateVariant(variants[0].id, { enabled: false })
    expect(getVariants()[0].enabled).toBe(false)

    saveVariants(getVariants())
    const restored = loadVariants()
    expect(restored?.[0].enabled).toBe(false)
  })

  it('禁用的变体不参与批量生成，其余变体不受影响', () => {
    const variants = getVariants()
    updateVariant(variants[0].id, { enabled: false })

    const result = startRun()
    expect(result.ok).toBe(true)
    // 5 组默认（各 2 候选）禁用 1 组 → 8 个任务，且不含被禁用变体
    expect(result.enqueued).toBe(8)
    expect(getTasks().every((t) => t.variantId !== variants[0].id)).toBe(true)
  })

  it('全部禁用时 startRun 拒绝并给出可行动的错误信息', () => {
    for (const v of getVariants()) updateVariant(v.id, { enabled: false })
    const result = startRun()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有启用的变体')
    expect(getTasks().length).toBe(0)
  })

  it('旧持久化数据（无 enabled 字段）加载后视为启用，显式 false 保持禁用', () => {
    localStorage.setItem(
      'rhinestone-studio:variants',
      JSON.stringify([
        { id: 'v1', name: '旧变体', prompt: 'p', candidates: 2 },
        { id: 'v2', name: '旧禁用', prompt: 'p', candidates: 2, enabled: false },
      ]),
    )
    const restored = loadVariants()
    expect(restored?.[0].enabled).toBe(true)
    expect(restored?.[1].enabled).toBe(false)
  })

  it('defaultVariants 全部带 enabled: true', () => {
    expect(defaultVariants().every((v) => v.enabled)).toBe(true)
  })
})

describe('参考图预览响应式回归（曾因一次性 const 失聪）', () => {
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
