/*
 * [波 5 P3-2] 模型 id 手改持久化回归：编辑器（RouteTabContent 全局 Save）与
 * NewRouteTab form 态（创建路由）的保存载荷必须携带编辑后的模型 id（「id 改动
 * 不被静默丢弃」）。jsdom + fake modelsApi（save 载荷全量快照断言）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { ModelsConfigOutput } from '@handicraft/contracts'

// ---------------------------------------------------------------------------
// fake 客户端（vi.hoisted：vi.mock 工厂提升早于模块体，共享状态放这里）
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const state = {
    config: {
      routes: [
        {
          provider: 'zai',
          api: 'openai-completions',
          baseURL: 'https://api.example.com/v1',
          hasKey: true,
          models: [{ id: 'old-model', name: '旧模型名' }],
        },
      ],
      default: { provider: 'zai', model: 'old-model' },
    } as ModelsConfigOutput,
    saveCalls: [] as unknown[],
  }
  const client = {
    async getModels(): Promise<ModelsConfigOutput> {
      return JSON.parse(JSON.stringify(state.config)) as ModelsConfigOutput
    },
    async saveModels(next: { routes: unknown[]; default: unknown }): Promise<void> {
      state.saveCalls.push(JSON.parse(JSON.stringify(next)))
      // 落库语义对齐 daemon saveModelsConfig：全量覆盖（default 校验归 daemon，
      // 此处原样回读——id 持久化断言不依赖 default 分支）。
      state.config = next as unknown as ModelsConfigOutput
    },
    async getModelsCatalog() {
      return { presets: [], fetched_at: null }
    },
    async refreshModelsCatalog() {
      return { presets: [], fetched_at: null }
    },
    async testModelRoute() {
      return { ok: true, latencyMs: 1 }
    },
    async getAvailableModels() {
      return { models: [], default: null }
    },
    async getModelRoute() {
      return null
    },
  }
  return { state, client }
})

vi.mock('$lib/modelsApi', () => ({ modelsApi: () => fake.client }))

import ModelsConfig from '../../lib/components/models/ModelsConfig.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

const mountedDisposers: Array<() => void> = []

function mountConfig(): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(ModelsConfig, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `选择器 ${selector} 应命中`).not.toBeNull()
  return el as HTMLElement
}

function setInput(selector: string, value: string): void {
  const input = q(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function clickButtonByText(scope: HTMLElement, text: string): void {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button, `按钮「${text}」应存在`).toBeDefined()
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake.state.config = {
    routes: [
      {
        provider: 'zai',
        api: 'openai-completions',
        baseURL: 'https://api.example.com/v1',
        hasKey: true,
        models: [{ id: 'old-model', name: '旧模型名' }],
      },
    ],
    default: { provider: 'zai', model: 'old-model' },
  } as ModelsConfigOutput
  fake.state.saveCalls = []
})

afterEach(() => {
  while (mountedDisposers.length > 0) mountedDisposers.pop()!()
  document.body.innerHTML = ''
})

describe('P3-2：模型 id 手改后保存载荷持久化', () => {
  it('编辑器：手改模型 id → 全局 Save 载荷携带新 id（不被静默丢弃）', async () => {
    mountConfig()
    await waitUntil(() => document.querySelector('[role="tab"]') !== null)

    // 展开模型条目（编辑按钮 aria-label=编辑模型 {id}）。
    q('[aria-label="编辑模型 old-model"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    // 手改 id（oninput → onIdInput → emit({id})——每次输入都回传）。
    setInput('[aria-label="模型 id"]', 'glm-5.3-flash')
    await flush()

    // 全局 Save（标题行右端——面板内唯一「保存」文本按钮）。
    clickButtonByText(document.body as HTMLElement, '保存')
    await waitUntil(() => fake.state.saveCalls.length > 0)

    const payload = fake.state.saveCalls[0] as {
      routes: Array<{ provider: string; models: Array<{ id: string; name?: string }> }>
    }
    expect(payload.routes).toHaveLength(1)
    // 核心断言：保存载荷的模型 id = 编辑后的值（携带 name 等富字段）。
    expect(payload.routes[0]!.models[0]!.id).toBe('glm-5.3-flash')
    expect(payload.routes[0]!.models[0]!.name).toBe('旧模型名')

    // 保存后读面重建：新 id 回显（落库-回读往返）。
    await waitUntil(() => document.querySelector('[aria-label="编辑模型 glm-5.3-flash"]') !== null)
  })

  it('NewRouteTab form 态：加模型手填 id → 创建路由载荷携带 id', async () => {
    fake.state.config = { routes: [], default: null } as unknown as ModelsConfigOutput
    mountConfig()
    await waitUntil(() => document.body.textContent?.includes('添加第一个模型路由'))

    // 打开新路由面板（pick 态）→ 切自定义端点表单。
    clickButtonByText(document.body as HTMLElement, '+ 新路由')
    await flush()
    clickButtonByText(document.body as HTMLElement, '自定义端点 →')
    await flush()

    setInput('[aria-label="路由名"]', 'my-provider')
    setInput('[aria-label="Base URL"]', 'https://api.example.com/v1')
    // 加模型（挂载即展开的新空条目）→ 手填 id。
    clickButtonByText(document.body as HTMLElement, '+ 加模型')
    await flush()
    setInput('[aria-label="模型 id"]', 'custom-model-id')
    await flush()

    clickButtonByText(document.body as HTMLElement, '创建路由')
    await waitUntil(() => fake.state.saveCalls.length > 0)

    const payload = fake.state.saveCalls[0] as {
      routes: Array<{ provider: string; models: Array<{ id: string }> }>
    }
    expect(payload.routes).toHaveLength(1)
    expect(payload.routes[0]!.provider).toBe('my-provider')
    expect(payload.routes[0]!.models[0]!.id).toBe('custom-model-id')
  })
})
