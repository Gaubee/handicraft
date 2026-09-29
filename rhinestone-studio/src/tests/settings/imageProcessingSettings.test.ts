/*
 * [add-image-processing-settings 2.4] 设置 Sheet 多分区壳 + 图像处理分区逻辑测试
 * （jsdom——DOM/逻辑断言，无像素断言；宽窄两态的容器查询视觉走查归 vision 子代理，
 * 本文件覆盖导航结构在两种形态下共用的 DOM 面：分区项在场+切换语义）。
 * 注入面：$lib/imageProcessingApi 与 $lib/modelsApi 经 vi.mock 替换 fake client
 * （真链联调由 MainAgent 合流后做）。fake save 语义对齐 daemon：非 custom 档按冻结
 * 映射回读面（入参 values 忽略）、custom 档回显入参 values、reset 回落态。
 * 覆盖（tasks 2.4）：分区导航切换/store 直达 / 预设选择脏态+保存载荷（非 custom 无
 * values）/ custom 展开四控件+保存载荷全四字段 / maskMaxSide 开关联动 null↔数值 /
 * custom 非法值前置校验（保存禁用+提示）/ 来源行三态 / reset 载荷 / 顶栏入口 testid。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type {
  ImageProcessingGetOutput,
  ImageProcessingSaveInput,
  ImageProcessingValues,
} from '@handicraft/contracts'

// ---------------------------------------------------------------------------
// fake 客户端（vi.hoisted：vi.mock 工厂提升早于模块体，共享状态放这里）
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const PRESET_MAP: Record<string, ImageProcessingValues> = {
    fast: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 },
    balanced: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
    quality: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null },
  }
  const defaultState: ImageProcessingGetOutput = {
    settings: null,
    source: 'default',
    effective: { ...PRESET_MAP.balanced! },
  }
  const state = {
    getOutput: defaultState,
    resetOutput: defaultState,
    saveCalls: [] as ImageProcessingSaveInput[],
  }
  const client = {
    async getImageProcessing(): Promise<ImageProcessingGetOutput> {
      return state.getOutput
    },
    async saveImageProcessing(input: ImageProcessingSaveInput): Promise<ImageProcessingGetOutput> {
      state.saveCalls.push(JSON.parse(JSON.stringify(input)) as ImageProcessingSaveInput)
      if ('reset' in input) {
        state.getOutput = state.resetOutput
        return state.getOutput
      }
      // 非 custom：服务端按冻结映射生成快照（入参 values 忽略）——daemon 同构。
      const values = input.preset === 'custom' ? input.values! : PRESET_MAP[input.preset]!
      state.getOutput = { settings: { preset: input.preset, values }, source: 'settings', effective: values }
      return state.getOutput
    },
  }
  return { state, client }
})

vi.mock('$lib/imageProcessingApi', () => ({ imageProcessingApi: () => fake.client }))

// modelsApi 替身（models 分区挂载确定性——空路由空态；不触发真实 WS/fetch）。
const fakeModels = vi.hoisted(() => ({
  async getModels() {
    return { routes: [], default: null }
  },
  async saveModels() {
    return { routes: [], default: null }
  },
  async getModelsCatalog() {
    return { presets: [] }
  },
  async refreshModelsCatalog() {
    return { presets: [] }
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
}))
vi.mock('$lib/modelsApi', () => ({ modelsApi: () => fakeModels }))

import ModelsSettingsDialog from '../../components/ModelsSettingsDialog.svelte'
import ImageProcessingConfig from '../../lib/components/settings/ImageProcessingConfig.svelte'
import {
  closeModelsSettings,
  getSettingsSection,
  openModelsSettings,
  resetModelsSettingsForTests,
} from '../../lib/stores/modelsSettingsDialog.svelte'

// jsdom 未实现 scrollIntoView（App 挂载链）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

/**
 * 挂载 Sheet 壳并冲刷一轮再返回——mount 同一同步块内翻 store open 会触发
 * bits-ui Dialog presence 竞态（Sheet 内容永不挂载，jsdom 实证）；真实用户流
 * （App 先挂载、用户稍后点击）天然间隔一轮 tick，测试面对齐该时序。
 */
async function mountDialogReady(): Promise<void> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(ModelsSettingsDialog, { target })
  mountedDisposers.push(() => {
    unmount(app)
    target.remove()
  })
  await tick()
}

async function flush(ms = 10): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(10)
  if (!condition()) throw new Error(`waitUntil 超时（${ms}ms）`)
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (el === null) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

function radio(preset: string): HTMLElement {
  return q(`[data-testid="image-processing-preset-${preset}"]`)
}

function saveButton(): HTMLButtonElement {
  return q('[data-testid="image-processing-save-button"]') as HTMLButtonElement
}

/** bits-ui Slider thumb 键盘驱动（jsdom 可达路径——Home/End/Arrow 经 thumb keydown 更新值）。 */
function pressSliderKey(sliderTestid: string, key: string): void {
  q(`[data-testid="${sliderTestid}"] [data-slot="slider-thumb"]`).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

/** 拨 Switch（bits-ui root 是 button[role=switch]，click 切换 checked）。 */
async function clickSwitch(testid: string): Promise<void> {
  q(`[data-testid="${testid}"] button[role="switch"], [data-testid="${testid}"][role="switch"]`).click()
  await tick()
}

/** 打开 Sheet 并等图像处理分区就绪（get 异步读面）。 */
async function openOnImageProcessing(): Promise<void> {
  openModelsSettings('image-processing')
  await tick()
  await waitUntil(() => document.querySelector('[data-testid="image-processing-preset-group"]') !== null)
}

beforeEach(() => {
  fake.state.getOutput = {
    settings: null,
    source: 'default',
    effective: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
  }
  fake.state.resetOutput = fake.state.getOutput
  fake.state.saveCalls = []
  resetModelsSettingsForTests()
  closeModelsSettings()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  closeModelsSettings()
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// 2.2 多分区壳：分区导航 / store 直达
// ---------------------------------------------------------------------------

describe('设置 Sheet 多分区壳（2.2）', () => {
  it('分区导航：开 models 分区渲染模型服务内容，切换 image-processing 分区内容随之切换', async () => {
    await mountDialogReady()
    openModelsSettings()
    await tick()
    await waitUntil(() => document.querySelector('[data-testid="settings-sheet"]') !== null)

    // models 分区：ModelsConfig 空态（fake 空 routes，getModels 异步就绪）+ 双导航项在场
    await waitUntil(() => document.body.textContent?.includes('添加第一个模型路由') ?? false)
    expect(q('[data-testid="settings-nav-models"]').textContent?.trim()).toBe('模型服务')
    expect(q('[data-testid="settings-nav-image-processing"]').textContent?.trim()).toBe('图像处理')

    q('[data-testid="settings-nav-image-processing"]').click()
    await tick()
    await waitUntil(() => document.querySelector('[data-testid="image-processing-preset-group"]') !== null)
    expect(getSettingsSection()).toBe('image-processing')
    // models 分区内容卸载（{#if} 切换）
    expect(document.body.textContent).not.toContain('添加第一个模型路由')

    // 切回 models 分区
    q('[data-testid="settings-nav-models"]').click()
    await tick()
    await waitUntil(() => document.body.textContent?.includes('添加第一个模型路由') ?? false)
    expect(getSettingsSection()).toBe('models')
  })

  it('store 直达：openModelsSettings("image-processing") 打开即落图像处理分区', async () => {
    await mountDialogReady()
    await openOnImageProcessing()
    expect(getSettingsSection()).toBe('image-processing')
    expect(q('[data-testid="image-processing-preset-group"]').getAttribute('role')).toBe('radiogroup')
  })

  it('缺省分区：openModelsSettings() 落模型服务（显式缺省，不做上次分区记忆）', async () => {
    await mountDialogReady()
    openModelsSettings('image-processing')
    await tick()
    closeModelsSettings()
    await tick()
    openModelsSettings()
    await tick()
    await waitUntil(() => document.querySelector('[data-testid="settings-sheet"]') !== null)
    expect(getSettingsSection()).toBe('models')
  })
})

// ---------------------------------------------------------------------------
// 2.3 图像处理分区：预设组 / custom / 校验 / 来源行 / reset
// ---------------------------------------------------------------------------

describe('预设组（2.3）', () => {
  it('初始化：default 读面预选性能档，保存禁用（无脏态）', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    expect(radio('balanced').getAttribute('aria-checked')).toBe('true')
    expect(radio('fast').getAttribute('aria-checked')).toBe('false')
    expect(saveButton().disabled).toBe(true)
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).toBeNull()
    expect(document.querySelector('[data-testid="image-processing-custom-panel"]')).toBeNull()
  })

  it('点选高质量：本地态 preset=quality+脏态；保存载荷={preset:"quality"}（无 values）', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    radio('quality').click()
    await tick()

    expect(radio('quality').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(false)

    saveButton().click()
    await waitUntil(() => fake.state.saveCalls.length === 1)
    await flush()
    expect(fake.state.saveCalls[0]).toEqual({ preset: 'quality' })
    // 保存成功 inline 反馈
    expect(document.querySelector('[data-testid="image-processing-save-flash"]')).not.toBeNull()
  })

  it('非脏态保存被拒：初始化后直接点保存不产生调用', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    expect(saveButton().disabled).toBe(true)
    saveButton().click()
    await flush()
    expect(fake.state.saveCalls).toHaveLength(0)
  })
})

describe('custom 展开区（2.3）', () => {
  it('选自定义：展开四控件；改 ppcm slider 后保存载荷含 values 全四字段', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    radio('custom').click()
    await tick()

    expect(document.querySelector('[data-testid="image-processing-custom-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="image-processing-ppcm-slider"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="image-processing-ppcm-input"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="image-processing-resample-switch"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="image-processing-conf-slider"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="image-processing-mask-switch"]')).not.toBeNull()
    // mask 缺省关（default 读面 samMaskMaxSide=null）→ 数值输入不渲染
    expect(document.querySelector('[data-testid="image-processing-mask-input"]')).toBeNull()

    // ppcm slider 键盘驱动（End=50）
    pressSliderKey('image-processing-ppcm-slider', 'End')
    await tick()
    expect((q('[data-testid="image-processing-ppcm-input"]') as HTMLInputElement).value).toBe('50')

    saveButton().click()
    await waitUntil(() => fake.state.saveCalls.length === 1)
    expect(fake.state.saveCalls[0]).toEqual({
      preset: 'custom',
      values: { ppcmTarget: 50, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
    })
  })

  it('maskMaxSide 开关联动：开=1024 数值入载荷，关=null 且输入隐藏', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    radio('custom').click()
    await tick()

    await clickSwitch('image-processing-mask-switch')
    expect((q('[data-testid="image-processing-mask-input"]') as HTMLInputElement).value).toBe('1024')

    saveButton().click()
    await waitUntil(() => fake.state.saveCalls.length === 1)
    await flush()
    // fake 回 custom 读面 → initFrom 保持 custom，可继续联动
    expect((fake.state.saveCalls[0] as { values: ImageProcessingValues }).values.samMaskMaxSide).toBe(1024)

    await clickSwitch('image-processing-mask-switch')
    expect(document.querySelector('[data-testid="image-processing-mask-input"]')).toBeNull()

    saveButton().click()
    await waitUntil(() => fake.state.saveCalls.length === 2)
    expect((fake.state.saveCalls[1] as { values: ImageProcessingValues }).values.samMaskMaxSide).toBeNull()
  })

  it('非法值前置：ppcm 输入 9 → 校验提示+保存禁用；改回合法值恢复', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    radio('custom').click()
    await tick()

    const input = q('[data-testid="image-processing-ppcm-input"]') as HTMLInputElement
    input.value = '9'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(document.querySelector('[data-testid="image-processing-ppcm-invalid"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(true)

    input.value = '30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(document.querySelector('[data-testid="image-processing-ppcm-invalid"]')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it('非法掩码长边：mask 输入 16 → 提示+保存禁用', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    radio('custom').click()
    await tick()
    await clickSwitch('image-processing-mask-switch')

    const input = q('[data-testid="image-processing-mask-input"]') as HTMLInputElement
    input.value = '16'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    expect(document.querySelector('[data-testid="image-processing-mask-invalid"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(true)
  })
})

describe('来源行三态（2.3）', () => {
  it('settings 来源：透出已保存档名', async () => {
    fake.state.getOutput = {
      settings: { preset: 'fast', values: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 } },
      source: 'settings',
      effective: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe('当前生效：设置（快速档）')
    // 已保存档=当前标记 + 预选该档 + reset 可用
    expect(radio('fast').getAttribute('data-current')).toBe('true')
    expect(radio('fast').getAttribute('aria-checked')).toBe('true')
    expect((q('[data-testid="image-processing-reset-button"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('env 来源：附 PPCM_TARGET 值；preset 预选 effective 匹配档（quality）', async () => {
    fake.state.getOutput = {
      settings: null,
      source: 'env',
      effective: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null },
      env: { ppcmTarget: 40 },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe(
      '当前生效：环境变量（PPCM_TARGET=40 px/cm）',
    )
    // effective 匹配 quality 映射 → 预选 quality
    expect(radio('quality').getAttribute('aria-checked')).toBe('true')
    // 未保存（settings=null）→ reset 禁用（无事可恢复）
    expect((q('[data-testid="image-processing-reset-button"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('env 无 ppcmTarget：仅「环境变量」不附值；resampleEnabled=false 无匹配 → 不预选（P2-1）', async () => {
    fake.state.getOutput = {
      settings: null,
      source: 'env',
      effective: { ppcmTarget: 25, resampleEnabled: false, samConfThreshold: 0.4, samMaskMaxSide: null },
      env: { resampleDisabled: true },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe('当前生效：环境变量')
    // env 关降采（resampleEnabled=false）与任何预设映射不等 → 不预选（env 值不冒充
    // 已保存档——radiogroup 全灭+提示行；点击任何档即脏）
    for (const id of ['fast', 'balanced', 'quality', 'custom']) {
      expect(radio(id).getAttribute('aria-checked')).toBe('false')
    }
    expect(document.querySelector('[data-testid="image-processing-preset-hint"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('default 来源：默认（性能档）', async () => {
    await mountDialogReady()
    await openOnImageProcessing()

    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe('当前生效：默认（性能档）')
  })
})

describe('非预设 env 值显式保存（P2-1——codex 复核 2026-09-28）', () => {
  it('非预设 env（40/0.40 不匹配任何档）：初始无选中+保存禁用；点性能档 → 脏+载荷 {preset:"balanced"}；保存后回读 balanced', async () => {
    fake.state.getOutput = {
      settings: null,
      source: 'env',
      effective: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
      env: { ppcmTarget: 40 },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    // 初始：radiogroup 全灭（不冒充已保存档）+保存禁用+提示行在场
    for (const id of ['fast', 'balanced', 'quality', 'custom']) {
      expect(radio(id).getAttribute('aria-checked')).toBe('false')
    }
    expect(saveButton().disabled).toBe(true)
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).toBeNull()
    expect(document.querySelector('[data-testid="image-processing-preset-hint"]')).not.toBeNull()

    // 点性能档 → 脏+可保存（此前 bug：预选 balanced 冒充基线，点击不产生脏态）
    radio('balanced').click()
    await tick()
    expect(radio('balanced').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(false)

    saveButton().click()
    await waitUntil(() => fake.state.saveCalls.length === 1)
    await flush()
    expect(fake.state.saveCalls[0]).toEqual({ preset: 'balanced' })
    // fake 服务端按冻结映射回读 → 已保存态：预选+当前标记+来源行转设置
    expect(radio('balanced').getAttribute('aria-checked')).toBe('true')
    expect(radio('balanced').getAttribute('data-current')).toBe('true')
    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe('当前生效：设置（性能档）')
    expect(document.querySelector('[data-testid="image-processing-preset-hint"]')).toBeNull()
  })

  it('匹配预设的 env（quality 组合）仍预选该档：点击同档不脏（现状语义保留）', async () => {
    fake.state.getOutput = {
      settings: null,
      source: 'env',
      effective: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null },
      env: { ppcmTarget: 40 },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    expect(radio('quality').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-testid="image-processing-preset-hint"]')).toBeNull()
    radio('quality').click()
    await tick()
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).toBeNull()
    expect(saveButton().disabled).toBe(true)
    // 点其他档=脏
    radio('fast').click()
    await tick()
    expect(document.querySelector('[data-testid="image-processing-dirty"]')).not.toBeNull()
  })
})

describe('恢复跟随环境/默认（2.3）', () => {  it('确认后调 saveImageProcessing({reset:true}) 并以回落态重建', async () => {
    fake.state.getOutput = {
      settings: { preset: 'fast', values: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 } },
      source: 'settings',
      effective: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 },
    }
    fake.state.resetOutput = {
      settings: null,
      source: 'default',
      effective: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
    }
    await mountDialogReady()
    await openOnImageProcessing()

    q('[data-testid="image-processing-reset-button"]').click()
    await tick()

    const dialog = q('[role="alertdialog"]')
    expect(dialog.textContent).toContain('恢复跟随环境/默认')
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === '恢复')
    expect(confirm).toBeDefined()
    confirm!.click()
    await waitUntil(() => fake.state.saveCalls.length === 1)
    await flush()

    expect(fake.state.saveCalls[0]).toEqual({ reset: true })
    // 回落态重建：来源行转默认、预选性能档
    expect(q('[data-testid="image-processing-source-line"]').textContent?.trim()).toBe('当前生效：默认（性能档）')
    expect(radio('balanced').getAttribute('aria-checked')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 2.2 顶栏入口（App 挂载面）
// ---------------------------------------------------------------------------

describe('顶栏设置入口（2.2 / App 面；[split-admin-portal 1.5] 入口收为 admin 专属）', () => {
  it('admin 会话下 settings-button 存在（旧 models-settings-button 清零）且点击打开设置 Sheet', { timeout: 30000 }, async () => {
    const { MockAgentApi } = await import('$lib/agentApi/mock')
    const { bindAgentApi, resetAgentStoreForTests } = await import('$lib/agentApi/store.svelte')
    const { resetDevFlagForTests } = await import('../../lib/stores/devFlag.svelte')
    const { resetViewForTests } = await import('../../lib/stores/view.svelte')
    const { resetToastsForTests } = await import('../../lib/stores/toast.svelte')
    const { resetLabForTests } = await import('../../lib/stores/lab.svelte')
    // [split-admin-portal 1.5] 设置入口收为 admin 专属——非 admin 不可见的断言归
    // tests/admin/appRouting.test.ts；本用例注入 admin 会话验证入口动线本身。
    const { resetSessionForTests } = await import('../../lib/stores/session.svelte')
    const { resetRouterForTests } = await import('../../lib/router.svelte')
    const App = (await import('../../App.svelte')).default

    localStorage.clear()
    sessionStorage.clear()
    resetDevFlagForTests(false)
    resetViewForTests('agent')
    resetRouterForTests('')
    resetSessionForTests({ username: 'boss', role: 'admin' })
    resetAgentStoreForTests()
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    resetLabForTests()
    resetToastsForTests()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(App, { target })
    mountedDisposers.push(() => {
      unmount(app)
      target.remove()
    })
    await tick()

    expect(document.querySelector('[data-testid="models-settings-button"]')).toBeNull()
    const entry = q('[data-testid="settings-button"]') as HTMLButtonElement
    expect(entry.textContent).toContain('设置')
    expect(document.querySelector('[data-testid="settings-sheet"]')).toBeNull()

    entry.click()
    await tick()
    await waitUntil(() => document.querySelector('[data-testid="settings-sheet"]') !== null)
    expect(document.querySelector('[data-testid="settings-nav"]')).not.toBeNull()
    // 缺省分区=models（ModelsConfig getModels 异步就绪后空态）
    await waitUntil(() => document.body.textContent?.includes('添加第一个模型路由') ?? false)
  })
})

// ---------------------------------------------------------------------------
// 组件直挂：ImageProcessingConfig 单独挂载面（分区壳外也可用）
// ---------------------------------------------------------------------------

describe('ImageProcessingConfig 直挂', () => {
  it('加载失败：错误卡+重试（fake 抛错→恢复→重试成功）', async () => {
    const client = fake.client
    const failing = {
      getImageProcessing: async () => {
        throw new Error('daemon 不可达')
      },
    }
    // 局部替换：利用 vi.mock 工厂闭包引用 fake.client——此处直接换 client 方法再复原
    const original = client.getImageProcessing.bind(client)
    ;(client as unknown as { getImageProcessing: () => Promise<ImageProcessingGetOutput> }).getImageProcessing =
      failing.getImageProcessing

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(ImageProcessingConfig, { target })
    mountedDisposers.push(() => {
      unmount(app)
      target.remove()
    })
    await waitUntil(() => document.querySelector('[data-testid="image-processing-error"]') !== null)
    expect(q('[data-testid="image-processing-error"]').textContent).toContain('加载失败')

    ;(client as unknown as { getImageProcessing: () => Promise<ImageProcessingGetOutput> }).getImageProcessing = original
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重试')!.click()
    await waitUntil(() => document.querySelector('[data-testid="image-processing-error"]') === null)
    expect(document.querySelector('[data-testid="image-processing-preset-group"]')).not.toBeNull()
  })
})
