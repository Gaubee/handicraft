/**
 * [lab-ux 6] AdvancedParamsEditor 组件交互测试（improve-lab-advanced-ux 点 6）：
 * - Tabs 三页（可视化默认 / JSON 预览只读 / JSON 编辑）与双向同源（同一 form.advancedJson）；
 * - 可视化：已知字段控件（enum 哨兵「默认」= 键剥除；number 非法行内错误不落库）；
 *   自定义 key-value（value JSON 字面量严格 parse——非法行内错误、form 零变化；可删减）；
 * - 尺寸：双 input 回填旧载荷字符串（'1024x1536' → 1024/1536）、变更提交 'WxH'、
 *   快选 Dialog（比例分组 chips → 回填并闭窗）；
 * - JSON 编辑：非法 → 错误态不落库；合法 → 自动保存；未知键回流可视化自定义区。
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

import { getForm, resetLabForTests, updateForm } from '$lib/stores/lab.svelte'
import AdvancedParamsEditor from '../../components/Lab/AdvancedParamsEditor.svelte'

function q(target: HTMLDivElement, selector: string): HTMLElement {
  const el = target.querySelector(selector)
  if (!el) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

function docQ(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`document selector not found: ${selector}`)
  return el as HTMLElement
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function mountEditor(): Promise<{ target: HTMLDivElement; teardown: () => void }> {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(AdvancedParamsEditor, { target })
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

/** 切到指定 tab（bits-ui Tabs trigger 点击）。 */
async function switchTab(target: HTMLDivElement, testid: string): Promise<void> {
  q(target, `[data-testid="${testid}"]`).click()
  await tick()
}

beforeEach(() => {
  localStorage.clear()
  resetLabForTests()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

describe('[lab-ux 6] 可视化页：已知字段控件', () => {
  it('默认渲染三 tab + 已知字段控件 + 尺寸双 input + 快选按钮', async () => {
    const { target, teardown } = await mountEditor()
    expect(q(target, '[data-testid="advanced-tab-visual"]')).toBeTruthy()
    expect(q(target, '[data-testid="advanced-tab-preview"]')).toBeTruthy()
    expect(q(target, '[data-testid="advanced-tab-edit"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-known-quality"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-known-background"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-known-n"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-size-w"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-size-h"]')).toBeTruthy()
    expect(q(target, '[data-testid="adv-size-pick"]')).toBeTruthy()
    teardown()
  })

  it('enum 选值 → 落 form.advancedJson（注册表序序列化）；选回「默认」→ 键剥除', async () => {
    const { target, teardown } = await mountEditor()
    const select = q(target, '[data-testid="adv-known-quality"]') as HTMLSelectElement
    select.value = 'high'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe('{\n  "quality": "high"\n}')

    const bg = q(target, '[data-testid="adv-known-background"]') as HTMLSelectElement
    bg.value = 'transparent'
    bg.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe('{\n  "quality": "high",\n  "background": "transparent"\n}')

    // 选回默认 → 键剥除（序列化保持确定性序）
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe('{\n  "background": "transparent"\n}')
    teardown()
  })

  it('number 字段：合法数字落库（保持 number 类型）；非法 → 行内错误且 form 零变化', async () => {
    updateForm({ advancedJson: '' })
    const { target, teardown } = await mountEditor()
    const input = q(target, '[data-testid="adv-known-output_compression"]') as HTMLInputElement
    input.value = '80'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toContain('"output_compression": 80') // number 字面量非字符串

    const before = getForm().advancedJson
    input.value = '101'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe(before) // 越界不落库
    expect(q(target, '[data-testid="adv-known-error-output_compression"]').textContent).toContain('不应大于')
    teardown()
  })
})

describe('[lab-ux 6] 可视化页：自定义 key-value（未知字段）', () => {
  it('新增 seed=42 → JSON 含 number 字面量；改值 round-trip；删除键剥除', async () => {
    const { target, teardown } = await mountEditor()
    const newKey = q(target, '[data-testid="adv-custom-new-key"]') as HTMLInputElement
    newKey.value = 'seed'
    newKey.dispatchEvent(new Event('change', { bubbles: true }))
    const newValue = q(target, '[data-testid="adv-custom-new-value"]') as HTMLInputElement
    newValue.value = '42'
    newValue.dispatchEvent(new Event('change', { bubbles: true }))
    q(target, '[data-testid="adv-custom-add"]').click()
    await tick()
    expect(getForm().advancedJson).toContain('"seed": 42')

    // 行内改值（合法字面量）
    const value = q(target, '[data-testid="adv-custom-value-seed"]') as HTMLInputElement
    value.value = '"hot"'
    value.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toContain('"seed": "hot"')

    // 删除
    q(target, '[data-testid="adv-custom-remove-seed"]').click()
    await tick()
    expect(getForm().advancedJson).toBe('')
    teardown()
  })

  it('非法字面量 → 行内错误 + form 零变化（不落库）；新行键冲突拦截', async () => {
    updateForm({ advancedJson: '{"seed": 42}' })
    const { target, teardown } = await mountEditor()
    const before = getForm().advancedJson
    const value = q(target, '[data-testid="adv-custom-value-seed"]') as HTMLInputElement
    value.value = 'abc'
    value.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe(before)
    expect(q(target, '[data-testid="adv-custom-error-seed"]').textContent).toContain('解析失败')

    // 新行键冲突（已存在）
    const conflictKey = q(target, '[data-testid="adv-custom-new-key"]') as HTMLInputElement
    conflictKey.value = 'seed'
    conflictKey.dispatchEvent(new Event('change', { bubbles: true }))
    const conflictValue = q(target, '[data-testid="adv-custom-new-value"]') as HTMLInputElement
    conflictValue.value = '1'
    conflictValue.dispatchEvent(new Event('change', { bubbles: true }))
    q(target, '[data-testid="adv-custom-add"]').click()
    await tick()
    expect(q(target, '[data-testid="adv-custom-new-error"]').textContent).toContain('键已存在')
    teardown()
  })
})

describe('[lab-ux 6] 尺寸：双 input + 快选 Dialog', () => {
  it('旧载荷字符串回填：form.size=1024x1536 → 宽 1024 高 1536；变更提交 WxH', async () => {
    updateForm({ size: '1024x1536' })
    const { target, teardown } = await mountEditor()
    expect((q(target, '[data-testid="adv-size-w"]') as HTMLInputElement).value).toBe('1024')
    expect((q(target, '[data-testid="adv-size-h"]') as HTMLInputElement).value).toBe('1536')

    const w = q(target, '[data-testid="adv-size-w"]') as HTMLInputElement
    w.value = '1536'
    w.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().size).toBe('1536x1536')

    // 非法（0）→ 不提交 + 错误
    const before = getForm().size
    w.value = '0'
    w.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getForm().size).toBe(before)
    expect(q(target, '[data-testid="adv-size-error"]').textContent).toContain('正整数')
    teardown()
  })

  it('快选 Dialog：比例分组平铺 + chips 点击回填闭窗；当前非标值入自定义组', async () => {
    updateForm({ size: '640x480' })
    const { target, teardown } = await mountEditor()
    q(target, '[data-testid="adv-size-pick"]').click()
    await tick()
    await waitFor(() => document.querySelector('[data-testid="adv-size-pick-dialog"]') !== null)

    // 分组标题（1:1/3:2/2:3/7:4/4:7 + 自定义组含当前 640×480）
    const dialog = docQ('[data-testid="adv-size-pick-dialog"]')
    expect(dialog.textContent).toContain('1:1')
    expect(dialog.textContent).toContain('4:7')
    expect(dialog.textContent).toContain('自定义')
    expect(docQ('[data-testid="adv-size-chip-640x480"]').textContent).toContain('640 × 480')

    // 选 1024×1024 → form.size 更新 + 闭窗
    docQ('[data-testid="adv-size-chip-1024x1024"]').click()
    await tick()
    expect(getForm().size).toBe('1024x1024')
    await waitFor(() => document.querySelector('[data-testid="adv-size-pick-dialog"]') === null)
    teardown()
  })
})

describe('[lab-ux 6] Tabs 双向同源（JSON 预览 / JSON 编辑 ↔ 可视化）', () => {
  it('可视化编辑 → 预览页只读展示同一 JSON', async () => {
    const { target, teardown } = await mountEditor()
    const select = q(target, '[data-testid="adv-known-quality"]') as HTMLSelectElement
    select.value = 'low'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    await switchTab(target, 'advanced-tab-preview')
    expect(q(target, '[data-testid="adv-json-preview-text"]').textContent).toContain('"quality": "low"')
    teardown()
  })

  it('JSON 编辑：非法 → 错误态不落库；合法 → 自动保存；未知键回流可视化自定义区', async () => {
    const { target, teardown } = await mountEditor()
    await switchTab(target, 'advanced-tab-edit')
    const textarea = q(target, '[data-testid="adv-json-edit-textarea"]') as HTMLTextAreaElement

    // 非法 → 不落库 + 行内错误
    textarea.value = '{"seed": '
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe('')
    expect(q(target, '[data-testid="adv-json-edit-error"]')).toBeTruthy()

    // 合法 → 自动保存（原文透传保持格式）
    textarea.value = '{ "seed": 7, "quality": "high" }'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(getForm().advancedJson).toBe('{ "seed": 7, "quality": "high" }')
    expect(q(target, '[data-testid="adv-json-edit-ok"]')).toBeTruthy()

    // 未知键回流可视化：自定义区出现 seed 行；已知字段 select 回显 high
    await switchTab(target, 'advanced-tab-visual')
    expect(q(target, '[data-testid="adv-custom-value-seed"]')).toBeTruthy()
    expect((q(target, '[data-testid="adv-known-quality"]') as HTMLSelectElement).value).toBe('high')
    teardown()
  })
})
