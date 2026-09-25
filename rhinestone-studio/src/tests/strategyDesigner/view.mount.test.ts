/*
 * [add-subject-sam-pipeline P3.2] 策略设计器视图挂载测试（jsdom）。
 * 覆盖：视图结构（旅程链/左对话/右画布/图层树+参数侧栏）；会话流内 strategy.design
 * 工具调用卡升级（指派表+批准/拒绝复用授权 UI 形态）；FrameView 分派（策略卡 vs
 * 通用卡）；画布点阵渲染数据（颜色=StonePick/尺寸=mm×ppm）与逐节点显隐；参数表单
 * schema 驱动渲染+判别切换+调整指令注入对话输入框；free-code 只读源码面；原图
 * imageBlobRef 缺口降级与补入位。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import StrategyDesignerView from '$lib/components/strategy/StrategyDesignerView.svelte'
import StrategyCanvas from '$lib/components/strategy/StrategyCanvas.svelte'
import StrategyProposalCard from '$lib/components/strategy/StrategyProposalCard.svelte'
import FrameView from '$lib/components/agent/FrameView.svelte'
import type { Frame } from '@handicraft/contracts'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, initAgentStore, openSession, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { peekComposerText, resetComposerOutboxForTests } from '$lib/agentApi/composerOutbox.svelte'
import { MockStrategyArtifacts, STRATEGY_FIXTURE_BLOB_REFS } from '$lib/strategyDesigner/fixtures'
import {
  bindStrategyArtifactsProvider,
  resetStrategyDesignerForTests,
  syncStrategyArtifacts,
} from '$lib/strategyDesigner/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

// jsdom 未实现 scrollIntoView（会话流自动滚动）——桩掉。
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()

const mountedDisposers: Array<() => void> = []

function mountView(props: Record<string, never> = {}): () => void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(StrategyDesignerView, { target, props })
  const dispose = () => {
    unmount(view)
    target.remove()
  }
  mountedDisposers.push(dispose)
  return dispose
}

async function flush(ms = 30): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function q(selector: string): Element | null {
  return document.querySelector(selector)
}

function qq(selector: string): Element[] {
  return [...document.querySelectorAll(selector)]
}

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetStrategyDesignerForTests()
  resetComposerOutboxForTests()
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  // 先完成 store 初始化（默认开 heart）——视图 onMount 的 initAgentStore 幂等直通，
  // 不把测试已切换的 willow 会话切回默认会话。
  await initAgentStore()
})

afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('视图结构：左对话右画布+旅程链（willow 全旅程）', () => {
  it('六面齐备：旅程链/会话流/画布/图层树/参数面/会话选择器', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await flush()

    expect(q('[data-testid="strategy-view"]')).not.toBeNull()
    expect(q('[data-testid="strategy-journey"]')).not.toBeNull()
    expect(q('[data-testid="agent-stream"]')).not.toBeNull() // 左=Agent 会话流复用
    expect(q('[data-testid="strategy-canvas"]')).not.toBeNull()
    expect(q('[data-testid="strategy-layer-tree"]')).not.toBeNull()
    expect(q('[data-testid="strategy-params-form"]')).not.toBeNull()
    expect(q('[data-testid="strategy-session-select"]')).not.toBeNull()
    dispose()
  })

  it('旅程链：六步全 done + 工件名 chip 透出（object-tree.json/strategy-gems.json）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await flush()

    const steps = qq('[data-testid^="strategy-journey-step-"]')
    expect(steps).toHaveLength(6)
    expect(steps.every((step) => step.getAttribute('data-status') === 'done')).toBe(true)
    const chips = qq('[data-testid="strategy-journey-artifact"]').map((chip) => chip.textContent?.trim())
    expect(chips).toContain('object-tree.json')
    expect(chips).toContain('strategy-gems.json')
    expect(chips).toContain('strategy-gems-preview.png')
    dispose()
  })

  it('空旅程会话（starry）→ 全 pending 画布空态引导', async () => {
    await openSession('fixt-session-starry')
    const dispose = mountView()
    await flush()

    expect(qq('[data-testid^="strategy-journey-step-"]').every((step) => step.getAttribute('data-status') === 'pending')).toBe(true)
    expect(q('[data-testid="strategy-canvas-empty"]')).not.toBeNull()
    expect(q('[data-testid="strategy-layer-empty"]')).not.toBeNull()
    dispose()
  })
})

describe('画布：三层叠加渲染数据', () => {
  it('点阵 19 颗（颜色=指派 StonePick colorHex）+框线 6（排除=灯头标记）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 19)

    const gems = qq('[data-testid="strategy-gem"]') as SVGCircleElement[]
    expect(gems).toHaveLength(19)
    const flowerGem = gems.find((gem) => gem.getAttribute('data-node-id') === 'n-flower')!
    expect(flowerGem.getAttribute('fill')).toBe('#E16FA8') // 颜色=StonePick colorHex
    expect(Number(flowerGem.getAttribute('r'))).toBeCloseTo(2.5) // 尺寸=mm×ppm/2（2.5mm×2/2）

    const boxes = qq('[data-testid="strategy-node-box"]')
    expect(boxes).toHaveLength(6)
    const lampLabel = qq('[data-testid="strategy-node-label"]').find((label) => label.textContent?.includes('路灯'))
    expect(lampLabel?.textContent).toContain('（不贴）')
    dispose()
  })

  it('逐节点显隐（图层树开关）：隐藏花朵 → 画布 11 颗+框线 5', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 19)

    ;(q('[data-testid="strategy-layer-visible-n-flower"]') as HTMLButtonElement).click()
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 11)
    expect(qq('[data-testid="strategy-node-box"]')).toHaveLength(5)
    // 框线总开关：关 → 全部框线退场（点阵保留）
    ;(q('[data-testid="strategy-boxes-toggle"]') as HTMLInputElement).click()
    await flush()
    expect(qq('[data-testid="strategy-node-box"]')).toHaveLength(0)
    expect(qq('[data-testid="strategy-gem"]')).toHaveLength(11)
    dispose()
  })

  it('原图缺口降级：mock 无 sourceImageUrl → 降级注记+开关禁用', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-gem"]').length === 19)

    expect(q('[data-testid="strategy-base-missing"]')).not.toBeNull()
    expect((q('[data-testid="strategy-base-toggle"]') as HTMLInputElement).disabled).toBe(true)
    dispose()
  })

  it('原图补入位：provider 带 sourceImageUrl → image 层+透明度滑杆在', async () => {
    bindStrategyArtifactsProvider(new MockStrategyArtifacts({ sourceImageUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }))
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => q('[data-testid="strategy-base-image"]') !== null)

    expect(q('[data-testid="strategy-base-missing"]')).toBeNull()
    expect((q('[data-testid="strategy-base-toggle"]') as HTMLInputElement).disabled).toBe(false)
    expect(q('[data-testid="strategy-base-opacity"]')).not.toBeNull()
    dispose()
  })
})

describe('图层树与参数表单（schema 驱动）', () => {
  it('树行 6：kind 徽标/参数摘要/drillWorthy 标记（画布根=层级徽标）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    expect(q('[data-testid="strategy-layer-kind-n-willow"]')?.textContent).toContain('层级')
    expect(q('[data-testid="strategy-layer-kind-n-branch"]')?.textContent).toContain('texture-fill')
    expect(q('[data-testid="strategy-layer-params-n-branch"]')?.textContent).toContain('mode=flow')
    expect(q('[data-testid="strategy-layer-params-n-branch"]')?.textContent).toContain('2.3/cm²')
    expect(q('[data-testid="strategy-layer-excluded-n-lamp"]')).not.toBeNull() // drillWorthy=false 标记
    dispose()
  })

  it('选中枝条 → 参数面（纹理贴图）；判别切换 flow→scatter 出 Lloyd 迭代字段', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    ;(q('[data-testid="strategy-layer-select-n-branch"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="strategy-params-kind"]')?.textContent).toContain('纹理贴图')
    expect(q('[data-testid="strategy-params-field-polarity"]')).not.toBeNull()
    expect(q('[data-testid="strategy-params-field-lloydIters"]')).toBeNull() // flow 变体无迭代

    const discriminant = q('[data-testid="strategy-params-discriminant"]') as HTMLSelectElement
    discriminant.value = 'scatter'
    discriminant.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(q('[data-testid="strategy-params-field-lloydIters"]')).not.toBeNull()
    dispose()
  })

  it('几何判别：星形字段集（rays/innerRadiusRatio/rotationDeg）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    ;(q('[data-testid="strategy-layer-select-n-flower"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="strategy-params-field-rays"]')).not.toBeNull()
    expect(q('[data-testid="strategy-params-field-innerRadiusRatio"]')).not.toBeNull()
    expect(q('[data-testid="strategy-params-field-rotationDeg"]')).not.toBeNull()
    const rays = q('[data-testid="strategy-params-field-rays"]') as HTMLInputElement
    expect(rays.getAttribute('min')).toBe('3')
    expect(rays.getAttribute('max')).toBe('64')
    dispose()
  })

  it('free-code 层：codeArtifact 链接+源码只读预览+注入 API 面（无表单控件）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    ;(q('[data-testid="strategy-layer-select-n-ribbon"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="strategy-params-code-ref"]')?.textContent).toContain(STRATEGY_FIXTURE_BLOB_REFS.codeArtifact.slice(0, 10))
    expect(q('[data-testid="strategy-params-code-meta"]')?.textContent).toContain('entryPoint=layout')
    expect(q('[data-testid="strategy-params-code-meta"]')?.textContent).toContain('seed=7')
    const source = q('[data-testid="strategy-params-code-source"]')?.textContent ?? ''
    expect(source).toContain('function layout(sandbox)')
    expect(q('[data-testid="strategy-params-compose"]')).toBeNull() // free-code 无参数表单面
    dispose()
  })

  it('调整指令注入：改参数+密度 → 指令文本落对话输入框（agent-composer）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    ;(q('[data-testid="strategy-layer-select-n-branch"]') as HTMLButtonElement).click()
    await flush()
    const polarity = q('[data-testid="strategy-params-field-polarity"]') as HTMLSelectElement
    polarity.value = 'bright-dense'
    polarity.dispatchEvent(new Event('change', { bubbles: true }))
    const density = q('[data-testid="strategy-params-field-density"]') as HTMLInputElement
    density.value = '3.2'
    density.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()

    ;(q('[data-testid="strategy-params-compose"]') as HTMLButtonElement).click()
    await waitUntil(() => peekComposerText() === null) // 消费即清空（SessionStream 注入）
    const composer = q('[data-testid="agent-composer"]') as HTMLTextAreaElement
    expect(composer.value).toContain('nodeId=n-branch')
    expect(composer.value).toContain('polarity=bright-dense')
    expect(composer.value).toContain('密度：3.2 颗/cm²')
    expect(composer.value).toContain('J-303 深柳绿 3mm')
    dispose()
  })

  it('参数面空态：未选层引导文案', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-layer-row"]').length === 6)

    expect(q('[data-testid="strategy-params-empty"]')?.textContent).toContain('选择一个图层')
    // 层级节点选中 → 层级不承载指派提示
    ;(q('[data-testid="strategy-layer-select-n-willow"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="strategy-params-empty"]')?.textContent).toContain('层级节点')
    dispose()
  })
})

describe('工具调用卡升级：strategy.design proposal 呈现', () => {
  it('会话流内策略审批帧 → 指派表卡（4 行：策略/参数摘要/钻色/密度/理由）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await waitUntil(() => qq('[data-testid="strategy-proposal-row"]').length === 4)

    const rows = qq('[data-testid="strategy-proposal-row"]')
    expect(rows).toHaveLength(4)
    const branchRow = rows.find((row) => row.getAttribute('data-node-id') === 'n-branch')!
    expect(branchRow.textContent).toContain('柳树·枝条')
    expect(branchRow.textContent).toContain('纹理贴图')
    expect(q('[data-testid="strategy-proposal-params-n-branch"]')?.textContent).toContain('mode=flow')
    expect(branchRow.textContent).toContain('2.3/cm²')
    expect(branchRow.textContent).toContain('J-303')
    // 已 resolved → 已处理态（无批准/拒绝按钮）
    expect(branchRow.textContent).toContain('顺枝条') // 理由列
    expect(q('[data-testid="strategy-proposal-approve"]')).toBeNull()
    dispose()
  })

  it('pending 态 → 批准/拒绝按钮走授权通道（answerApproval）', async () => {
    await openSession('fixt-session-willow')
    const api = new MockAgentApi({ speed: 0 })
    const spy = vi.spyOn(api, 'answer').mockResolvedValue({ ok: true })
    bindAgentApi(api)
    await openSession('fixt-session-willow')

    const frame: Extract<Frame, { kind: 'approval-request' }> = {
      seq: 1,
      ts: Date.now(),
      kind: 'approval-request',
      payload: {
        requestId: 'fixt-request-willow',
        tool: 'studio.strategy.design',
        proposalId: 'fixt-proposal-willow',
        preview: { before: STRATEGY_FIXTURE_BLOB_REFS.proposalPreviewBefore, after: STRATEGY_FIXTURE_BLOB_REFS.proposalPreviewAfter },
        summary: '策略设计：4 节点指派',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }
    const target = document.createElement('div')
    document.body.appendChild(target)
    const card = mount(StrategyProposalCard, { target, props: { frame, pending: true } })
    mountedDisposers.push(() => {
      unmount(card)
      target.remove()
    })
    // 指派表数据源=store 工件投影（willow 已装载）
    syncStrategyArtifacts()
    await flush()
    expect(qq('[data-testid="strategy-proposal-row"]').length).toBeGreaterThan(0)

    ;(q('[data-testid="strategy-proposal-approve"]') as HTMLButtonElement).click()
    await flush()
    expect(spy).toHaveBeenCalledWith('fixt-session-willow', 'fixt-request-willow', true)
    spy.mockRestore()
  })

  it('工件未装载 → 指派表降级提示（摘要兜底不空白）', async () => {
    bindStrategyArtifactsProvider({ load: async () => null })
    await openSession('fixt-session-willow')
    syncStrategyArtifacts()
    await flush()
    const frame: Extract<Frame, { kind: 'approval-request' }> = {
      seq: 1,
      ts: Date.now(),
      kind: 'approval-request',
      payload: {
        requestId: 'r1',
        tool: 'studio.strategy.design',
        proposalId: 'p1',
        preview: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
        summary: '策略设计：4 节点指派',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }
    const target = document.createElement('div')
    document.body.appendChild(target)
    const card = mount(StrategyProposalCard, { target, props: { frame, pending: false } })
    mountedDisposers.push(() => {
      unmount(card)
      target.remove()
    })
    expect(q('[data-testid="strategy-proposal-table-missing"]')).not.toBeNull()
  })

  it('FrameView 分派：strategy.design→策略卡；其余工具→通用审批卡', async () => {
    await openSession('fixt-session-willow')
    syncStrategyArtifacts()
    await flush()
    const base = {
      seq: 1,
      ts: Date.now(),
      payload: {
        requestId: 'r1',
        proposalId: 'p1',
        preview: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
        summary: 's',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }
    const strategyFrame = { ...base, kind: 'approval-request', payload: { ...base.payload, tool: 'studio.strategy.design' } } as Frame
    const genericFrame = { ...base, kind: 'approval-request', payload: { ...base.payload, tool: 'studio.patch-apply' } } as Frame

    // Svelte 5 mount 无 $set——两帧各挂一遍（同 target 顺序替换）。
    const target = document.createElement('div')
    document.body.appendChild(target)
    const strategyHost = mount(FrameView, { target, props: { frame: strategyFrame } })
    expect(q('[data-testid="strategy-proposal-card"]')).not.toBeNull()
    expect(q('[data-testid="approval-card"]')).toBeNull()
    unmount(strategyHost)

    const genericHost = mount(FrameView, { target, props: { frame: genericFrame } })
    mountedDisposers.push(() => {
      unmount(genericHost)
      target.remove()
    })
    expect(q('[data-testid="approval-card"]')).not.toBeNull()
    expect(q('[data-testid="strategy-proposal-card"]')).toBeNull()
  })
})

describe('StrategyCanvas 直挂（组件级）', () => {
  it('无工件 → 空态（装载中/错误态另计）', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const canvas = mount(StrategyCanvas, { target })
    mountedDisposers.push(() => {
      unmount(canvas)
      target.remove()
    })
    await flush()
    expect(q('[data-testid="strategy-canvas-empty"]')).not.toBeNull()
    expect(q('[data-testid="strategy-canvas"]')).toBeNull()
  })
})

describe('两层编辑铁律（策略层语义面）', () => {
  it('视图文案宣示图层级/禁单钻（铁律可感知）', async () => {
    await openSession('fixt-session-willow')
    const dispose = mountView()
    await flush()
    expect(q('[data-testid="strategy-params-form"]')?.textContent).toContain('禁单钻编辑')
    expect(q('[data-testid="strategy-proposal-card"]')?.textContent).toContain('单钻微调归设计师工作台')
    dispose()
  })
})
