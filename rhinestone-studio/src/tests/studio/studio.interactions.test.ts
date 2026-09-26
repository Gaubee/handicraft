/*
[2026-09-19 Test] 改版交互红点（R2–R4 + redesign-studio-layout 方案 A）：
1. 块详情置顶常驻（PM-B3/P0-4：选中即在手边，DOM 顺序先于块列表——检查器内 + 移动端抽屉同构）
2. 底部参数抽屉（R4：上下文条 [块][物理][色板] 入口开 bottom sheet——现行为硬承诺保留）
3. 策略单一真源（PM-B4/P0-2 + 方案 A 不变量：胶片带 chip = 唯一写入点，状态条只读回显）
4. 画布空态双 CTA（add-asset-library 5.1：从素材库选择=主入口（选图器已接线）/ 直接上传=次入口）
5. 上下文条（1.2）：预览模式即时生效 + 主画布渲染分派（pickCanvasLayers 入参级断言，jsdom 无 2D 的取舍）；
   「更换」经 AssetPickerController（add-asset-library 5.1）
6. 状态条（2.3）：违规浮出（红徽标 + 修复直达 + 清单▾）与 spacing 导出门（禁用语义不变）
*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import {
    applyHandoffReference,
    dispatchLayerConfigOp,
    getActiveResult,
    getBackgroundObservation,
    getBlocks,
    getExportCheck,
    getLayerById,
    getLayerResult,
    getReferenceImage,
    setBackgroundObservation,
    loadFromEngineImage,
    resetStudioForTests,
    selectBlock,
    setReferenceFile,
    waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp } from '$lib/studio/history.svelte'
import { getDirtyLayerIds } from '$lib/studio/computeQueue.svelte'
import { getEditDoc, getGemCount, isEditDirty, loadFromHandoff, resetEditForTests } from '$lib/stores/edit.svelte'
import { getToasts, resetToastsForTests } from '$lib/stores/toast.svelte'
import { pickCanvasLayers } from '$lib/studio/previewRender'
import { getView, setView } from '$lib/stores/view.svelte'
import { fixtureShapes } from '../engine/helpers'
import { makeHandoff } from '../edit/helpers'
import { ingestAsset, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

// [2026-09-19 Preview-fix] 主画布渲染分派可测化：BlockCanvas 的重绘 effect 经 pickCanvasLayers 产出层计划
// （jsdom 无 2D 上下文，无法对主画布断言像素——以分派入参为「渲染分派」级断言，drawPreview 保持真实实现）
vi.mock('$lib/studio/previewRender', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/studio/previewRender')>()
    return { ...actual, pickCanvasLayers: vi.fn(actual.pickCanvasLayers) }
})

// jsdom 未实现 ResizeObserver；bits-ui Slider 内部依赖，桩掉以获得稳定挂载
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

async function mountStudio(): Promise<{ unmount: () => void }> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(StudioView, { target })
  await tick()
  // [add-task-detail-layer-workbench 2.4] StudioView 重构为路由：旧面板用例经「进入引擎实验」进引擎面
  const enter = document.querySelector<HTMLButtonElement>('[data-testid="studio-mode-engine-enter"]')
  if (enter !== null) enter.click()
  await tick()
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('工作台 · handoff 原图落位（R3 → add-asset-library 5.2 资产化）', () => {
  let fake: FakeIndexedDB

  beforeEach(async () => {
    fake = installFakeIndexedDB()
    fake.reset()
    resetAssetStoreForTests()
    localStorage.clear()
    resetStudioForTests()
    await runAssetMigration()
  })

  it('applyHandoffReference：按 referenceAssetId 解析落位（assetId + dataUrl 缓存），已手动上传则不覆盖', async () => {
    expect(getReferenceImage()).toBeNull()
    const { node } = await ingestAsset({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      name: 'ref.png',
      width: 1,
      height: 1,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    await applyHandoffReference(node.id)
    const ref = getReferenceImage()
    expect(ref?.name).toBe('ref.png')
    expect(ref?.assetId).toBe(node.id)
    expect(ref?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    // 已有原图（手动上传优先）：handoff 不覆盖
    const { node: later } = await ingestAsset({
      blob: new Blob([new Uint8Array([9])], { type: 'image/png' }),
      name: 'later.png',
      width: 1,
      height: 1,
      parentId: 'sys-uploads',
      source: 'upload',
    })
    await applyHandoffReference(later.id)
    expect(getReferenceImage()?.name).toBe('ref.png')

    // 无 referenceAssetId：无操作
    await applyHandoffReference(undefined)
    expect(getReferenceImage()?.name).toBe('ref.png')
  })

  it('applyHandoffReference：资产缺失（已删/软删）时静默跳过，不留半落位状态', async () => {
    await applyHandoffReference('ast-does-not-exist')
    expect(getReferenceImage()).toBeNull()
  })
})

describe('工作台 · 块详情置顶常驻（R3 / PM-B3 → 检查器 2.1）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('选中块后详情出现在检查器顶部（先于折叠组），且随选中切换更新', async () => {
    const { unmount } = await mountStudio()
    loadFromEngineImage(fixtureShapes(), 'redpoint.png', 'upload')
    await waitForStudioIdle()

    // 未选中：占位提示存在
    expect(document.querySelector('[data-testid="block-detail-empty"]')).not.toBeNull()

    const first = getBlocks()[0]
    selectBlock(first.id)
    await tick()

    const detail = document.querySelector('[data-testid="block-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain(first.label)
    expect(detail!.textContent).toContain('密度')

    // 置顶语义：详情在 DOM 顺序上先于折叠组（检查器内：详情置顶 → 色板/分块参数折叠组；
    // 「块列表」折叠组已废除——improve 1.3，#No 区块进左列图层树）
    const accordionTrigger = [...document.querySelectorAll('[data-testid="inspector"] button')].find((b) =>
      b.textContent?.includes('色板'),
    )
    expect(accordionTrigger).toBeDefined()
    expect(detail!.compareDocumentPosition(accordionTrigger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    unmount()
  })

  it('improve 1.2 移入图层真实生效：移动后新旧所属层重算落地 + 标签同步当前绑定', async () => {
    resetStudioForTests()
    setView('lab')
    loadFromEngineImage(fixtureShapes(), 'move-layer.png', 'upload')
    await waitForStudioIdle()
    const block = getBlocks()[0]!
    expect(getLayerResult('L1')?.gems.length ?? 0).toBeGreaterThan(0)
    dispatchStudioOp({ t: 'layer.create', name: '前景' })
    await waitForStudioIdle()

    const { unmount } = await mountStudio()
    selectBlock(block.id)
    await tick()
    // 标签同步当前绑定（默认兜底层「图层 1」——不再恒显「移入图层」）
    expect(document.querySelector('[data-testid="move-to-layer"]')?.textContent).toContain('当前：图层 1')

    // 移入 L2 → moveBlockToLayer 双标脏 → 无显式 recompute() 也重算落地（BUG 修复断言面）
    document.querySelector<HTMLElement>('[data-testid="move-to-layer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    document.querySelector<HTMLElement>('[data-testid="move-to-layer-L2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitForStudioIdle()

    expect(getLayerById('L2')?.blockIds).toEqual([block.id])
    expect(getLayerResult('L2')?.gems.length ?? 0).toBeGreaterThan(0) // 目标层已算
    expect(getDirtyLayerIds()).toEqual([])
    // 移入后标签同步新绑定
    document.querySelector<HTMLElement>('[data-testid="move-to-layer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelector('[data-testid="move-to-layer"]')?.textContent).toContain('当前：前景')
    // 菜单内当前所属层禁用（真实归属判定——rest 层按钮不再恒可点）
    expect(document.querySelector<HTMLButtonElement>('[data-testid="move-to-layer-L2"]')?.disabled).toBe(true)
    unmount()
  })
})

describe('工作台 · 移动端参数抽屉（R4，现行为硬承诺）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('[2.7] 点击「检查器」入口打开底部抽屉并渲染层配置卡（物理参数归层）', async () => {
    loadFromEngineImage(fixtureShapes(), 'drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('检查器'),
    )
    expect(entry).toBeDefined()
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="left-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.querySelector('[data-testid="layer-config-card"]')).not.toBeNull()
    expect(drawer!.textContent).toContain('排钻策略')
    expect(drawer!.textContent).toContain('gap')

    // 「图层」入口 → 图层面板抽屉（行结构齐备）
    const layersEntry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('图层'),
    )
    layersEntry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelector('[data-testid="left-drawer"] [data-testid="layer-panel"]')).not.toBeNull()

    unmount()
  })

  it('「块」抽屉内含块详情占位与只读分块参数（块列表折叠组已废除——improve 1.3 树化承接）', async () => {
    loadFromEngineImage(fixtureShapes(), 'blocks-drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('检查器'),
    )
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="left-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.querySelector('[data-testid="block-detail-empty"]')).not.toBeNull()
    // 「块列表」折叠组废除收据：检查器内不再存在 block-list
    expect(drawer!.querySelector('[data-testid="block-list"]')).toBeNull()
    // 分块参数折叠组在检查器抽屉内（破坏性警示升级文案在场）
    expect(drawer!.textContent).toContain('重分块将重置图层分配与块覆写')

    unmount()
  })
})

describe('工作台 · 策略单一真源（R3 / PM-B4 → 胶片带 2.2 + 状态条 2.3）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('[2.7] 策略唯一写入点 = 检查器层配置卡（胶片带废除）；状态条零策略回显', async () => {
    loadFromEngineImage(fixtureShapes(), 'truth.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    // 胶片带整区废除（死 API grep 面）
    expect(document.querySelector('[data-testid="strategy-film-strip"]')).toBeNull()
    // 状态条收窄：零策略回显、零 combobox
    const bar = document.querySelector('[data-testid="status-bar"]')
    expect(bar).not.toBeNull()
    expect(bar!.querySelector('[role="combobox"]')).toBeNull()
    expect(bar!.textContent).not.toContain('策略 ·')

    // 检查器层配置卡策略 Select = 全应用唯一策略写入点（trigger 在场；jsdom 不渲染 bits-ui
    // 浮层 option——写入经层配置 op，trigger 回显随派生视图更新）
    const trigger = document.querySelector('[data-testid="layer-strategy-select"]')
    expect(trigger).not.toBeNull()
    dispatchLayerConfigOp(['L1'], { strategy: 'hex-thin' }, undefined, { immediate: true })
    await waitForStudioIdle()
    expect(getLayerResult('L1')?.strategy).toBe('hex-thin')
    // jsdom 下 Select.Value 渲染原值（label 由浮层 item 提供——不挂载）；断言值回显
    expect(trigger!.textContent).toContain('hex-thin')
    unmount()
  })

  it('「更换」入口接线选图器（点击 → controller 请求挂起，取消不动当前图）', async () => {
    const { assetPicker } = await import('$lib/assets/controller.svelte')
    assetPicker.cancel()
    const { unmount } = await mountStudio()

    const change = document.querySelector<HTMLButtonElement>('[data-testid="change-source"]')
    expect(change).not.toBeNull()
    expect(change!.disabled).toBe(false)
    expect(change!.getAttribute('title')).toContain('素材库')

    change!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(assetPicker.request).not.toBeNull()
    assetPicker.cancel()
    expect(assetPicker.request).toBeNull()

    unmount()
  })
})

describe('工作台 · 上下文条预览控制（1.2：预览模式即时生效）', () => {
  let fake: FakeIndexedDB

  beforeEach(async () => {
    fake = installFakeIndexedDB()
    fake.reset()
    resetAssetStoreForTests()
    localStorage.clear()
    resetStudioForTests()
    await runAssetMigration()
    setView('lab')
  })

  it('[2.7] 预览 pill 废除（收编背景层源）；背景面板源选择即时生效', async () => {
    loadFromEngineImage(fixtureShapes(), 'preview.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    // 上下文条三模式 pill + 透明度滑杆废除（死 API grep 面）
    expect(document.querySelector('[data-testid="preview-mode-painting"]')).toBeNull()
    expect(document.querySelector('[data-testid="preview-mode-reference"]')).toBeNull()
    expect(document.querySelector('[data-testid="preview-mode-gems"]')).toBeNull()

    // 背景层选中（左列背景行）→ 检查器背景面板：源 Select 即时切换观察态
    document.querySelector('[data-testid="layer-row-background"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelector('[data-testid="background-panel"]')).not.toBeNull()
    const trigger = document.querySelector('[data-testid="background-source-select"]')
    expect(trigger).not.toBeNull()
    // jsdom 不渲染 bits-ui 浮层 option——源经观察态写入（面板 onValueChange 同一出口），面板回显
    setBackgroundObservation({ source: 'none' })
    await tick()
    expect(getBackgroundObservation().source).toBe('none')
    // jsdom 下 Select.Value 渲染原值；断言值回显
    expect(trigger!.textContent).toContain('none')

    unmount()
  })

  it('主画布渲染分派：三模式/透明度/有钻随 store 即时进入 pickCanvasLayers 入参', async () => {
    loadFromEngineImage(fixtureShapes(), 'preview-dispatch.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const pick = vi.mocked(pickCanvasLayers)
    // 载入即有结果：默认 gems 模式 → 纯钻分派（无底图层）
    // [2.5] 背景源默认数字油画（Owner 授权默认值变更）——初始分派 = painting + 50%
    expect(pick.mock.lastCall?.[0]).toEqual({
      background: { source: 'painting', opacity: 0.5, visible: true },
      hasGems: true,
    })

    // 背景源切换（原 pill 收编）→ 依赖触发：确实驱动主画布重绘分派
    setBackgroundObservation({ source: 'painting' })
    await tick()
    expect(pick.mock.lastCall?.[0]).toEqual({
      background: { source: 'painting', opacity: 0.5, visible: true },
      hasGems: true,
    })

    // 背景透明度（连拖终值）→ alpha 入参即时生效
    setBackgroundObservation({ opacity: 0.85 })
    await tick()
    expect(pick.mock.lastCall?.[0]).toEqual({
      background: { source: 'painting', opacity: 0.85, visible: true },
      hasGems: true,
    })

    // 纯钻回切（背景源 none）
    setBackgroundObservation({ source: 'none' })
    await tick()
    expect(pick.mock.lastCall?.[0]?.background.source).toBe('none') // 收编映射：无源 = 纯钻

    // 叠原：上传原图（入库走 fake IDB）→ 背景源 reference → reference 分派
    await setReferenceFile(new File([new Uint8Array([1, 2, 3, 4])], 'ref.png', { type: 'image/png' }))
    await tick()
    setBackgroundObservation({ source: 'reference' })
    await tick()
    expect(pick.mock.lastCall?.[0]).toEqual({
      background: { source: 'reference', opacity: 0.85, visible: true },
      hasGems: true,
    })

    unmount()
  })

  it('主画布无钻回落：空态挂载分派 hasGems=false（结果未落地 → 维持现状渲染）', async () => {
    const { unmount } = await mountStudio()
    await tick()
    expect(vi.mocked(pickCanvasLayers).mock.lastCall?.[0]).toEqual({
      background: { source: 'painting', opacity: 0.5, visible: true },
      hasGems: false,
    })
    unmount()
  })
})

describe('工作台 · 状态条违规浮出与导出门（2.3：spacing 门语义不变）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('注入 spacing 违规 → 红徽标 + [边界松弛][斥力修复] 直达 + 清单▾ 展开；导出按钮禁用', async () => {
    loadFromEngineImage(fixtureShapes(), 'violation.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    // 前置：默认结果合规可导出（fixture 引擎排布满足间距硬约束）
    const checkBefore = getExportCheck()
    expect(checkBefore.ready).toBe(true)
    expect(checkBefore.exportable).toBe(true)

    // 注入违规：把已有钻原位复制一颗（中心距 0 < 所需间距 → 联合 exportGate spacing 违规；
    // [2.3] perLayerResults 是深响应式 $state——代理外写触发 jointCheck（联合门）重算）
    const entry = getLayerResult('L1')
    expect(entry && !entry.error).toBe(true)
    entry!.gems.push({ ...entry!.gems[0]! })
    await tick()

    const checkAfter = getExportCheck()
    expect(checkAfter.exportable).toBe(false)
    expect(checkAfter.warnings.some((w) => w.kind === 'spacing')).toBe(true)

    // 违规浮出：红徽标 + 修复直达 + 清单入口
    const cluster = document.querySelector('[data-testid="violation-cluster"]')
    expect(cluster).not.toBeNull()
    expect(cluster!.textContent).toContain('违规')
    expect(document.querySelector('[data-testid="relax-boundary"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="relax-repulsion"]')).not.toBeNull()

    // 清单 ▾ 展开：违规明细列出
    document.querySelector('[data-testid="violation-toggle"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    const list = document.querySelector('[data-testid="violation-list"]')
    expect(list).not.toBeNull()
    // [2.7] 分层分组清单（intra 层内 / inter 层对）
    expect(list!.textContent).toContain('层「图层 1」内')

    // 导出门（R6 P0-1：四路共同硬阻断）：违规阻断三个导出按钮与送精修（exportGate 共同前置）
    for (const id of ['export-svg', 'export-bom', 'export-png', 'send-to-edit']) {
      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(btn, `${id} 应存在`).not.toBeNull()
      expect(btn!.disabled, `${id} 违规时应禁用`).toBe(true)
    }
    const send = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    // disabled 附带可达性提示（与导出按钮 blocked 文案同族）
    expect(send!.getAttribute('title')).toBe('修复联合校验违规后可送精修')

    unmount()
  })

  it('违规时送精修直接调用路径（覆盖确认弹窗确认键）硬阻断：不产生 handoff、不切视图、三段式提示', async () => {
    resetEditForTests()
    resetToastsForTests()
    loadFromEngineImage(fixtureShapes(), 'violation-direct.png', 'upload')
    await waitForStudioIdle()
    setView('studio')
    const { unmount } = await mountStudio()

    // 前置：合规可送；编辑器已有未保存文档（覆盖确认弹窗可达）
    expect(getExportCheck().exportable).toBe(true)
    loadFromHandoff(makeHandoff(6))
    expect(isEditDirty()).toBe(true)
    const docBefore = getEditDoc()

    // 弹窗开着时注入违规（performSendToEdit 不经 requestSendToEdit 的 canSendToEdit——直接调用面）
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')!.click()
    await tick()
    expect(document.querySelector('[data-testid="send-to-edit-confirm"]')).not.toBeNull()
    const entry = getLayerResult('L1')
    expect(entry && !entry.error).toBe(true)
    entry!.gems.push({ ...entry!.gems[0]! })
    await tick()
    expect(getExportCheck().exportable).toBe(false)

    // 确认键 → 硬阻断：弹窗关闭、edit 文档保持原样、不切视图、三段式 toast 呈现
    document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit-confirm"]')!.click()
    await new Promise((resolve) => setTimeout(resolve, 80)) // Dialog 关闭过渡沉降
    expect(document.body.textContent ?? '').not.toContain('覆盖当前精修内容') // 弹窗已关
    expect(getView()).toBe('studio') // 不切页
    expect(getEditDoc()).toBe(docBefore) // 不重建 handoff（同一引用 = 未换文档）
    const toasts = getToasts()
    expect(toasts.length).toBe(1)
    expect(toasts[0]!.message).toContain('送精修已阻断')
    expect(toasts[0]!.message).toContain('首项：') // 首项违规摘要
    expect(toasts[0]!.message).toContain('请先修复违规后再送精修') // 恢复动作

    unmount()
  })

  it('合规时送精修放行（双向对照）：按钮可用 → handoff v2 正常交接切页；移动端菜单入口同门', async () => {
    resetEditForTests()
    resetToastsForTests()
    loadFromEngineImage(fixtureShapes(), 'compliant-send.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    // 合规：可送（exportGate 通过 = 第四路放行）
    expect(getExportCheck().ready).toBe(true)
    expect(getExportCheck().exportable).toBe(true)
    const send = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    expect(send!.disabled).toBe(false)
    expect(send!.getAttribute('title')).toBeNull()

    send!.click()
    await new Promise((resolve) => setTimeout(resolve, 80)) // 送精修异步（nextPaint 让帧）
    expect(getView()).toBe('edit')
    expect(getEditDoc()).not.toBeNull()
    expect(getGemCount()).toBe(getActiveResult()!.gems.length)
    // 放行路径零阻断提示（成功 toast 不在断言面——只须无「已阻断」）
    expect(getToasts().some((t) => t.message.includes('送精修已阻断'))).toBe(false)

    unmount()

    // 移动端菜单入口同门：matchMedia 桩到移动分支（组件初始化即读）→ 注入违规 → 菜单内四键同禁用
    //（jsdom 无 matchMedia 实现——直接赋值桩，结束后恢复）
    const originalMatchMedia = window.matchMedia
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query === '(max-width: 1023px)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
    try {
      const { unmount: unmount2 } = await mountStudio()
      setView('studio')
      await tick()
      const entry = getLayerResult('L1')
      expect(entry && !entry.error).toBe(true)
      entry!.gems.push({ ...entry!.gems[0]! })
      await tick()
      expect(getExportCheck().exportable).toBe(false)

      document.querySelector<HTMLButtonElement>('[data-testid="export-menu-toggle"]')!.click()
      await tick()
      for (const id of ['export-svg', 'export-bom', 'export-png', 'send-to-edit']) {
        const btn = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
        expect(btn, `${id} 移动端菜单应存在`).not.toBeNull()
        expect(btn!.disabled, `${id} 移动端菜单违规时应禁用`).toBe(true)
      }
      unmount2()
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})

describe('工作台 · 空态双 CTA（R3 → add-asset-library 5.1）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('studio')
  })

  it('空态主 CTA「从素材库选择」接线选图器（点击 → controller 请求挂起）；「直接上传」入口并存', async () => {
    const { assetPicker } = await import('$lib/assets/controller.svelte')
    const { getSourceImage } = await import('$lib/stores/studio.svelte')
    assetPicker.cancel()
    const { unmount } = await mountStudio()

    const empty = document.querySelector('[data-testid="canvas-empty"]')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain('还没有数字油画')

    const pickFromLibrary = document.querySelector<HTMLButtonElement>('[data-testid="empty-pick-from-library"]')
    expect(pickFromLibrary).not.toBeNull()
    expect(pickFromLibrary!.textContent).toContain('从素材库选择')
    expect(pickFromLibrary!.disabled).toBe(false)

    // 点击 → 选图器单实例请求挂起（Host 未挂载时 promise 保持 pending，不换图不报错）
    pickFromLibrary!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(assetPicker.request).not.toBeNull()
    expect(assetPicker.request?.multi).toBe(false)
    expect(getSourceImage()).toBeNull() // 未选定不动空态

    assetPicker.cancel()
    expect(document.querySelector('[data-testid="painting-upload"]')).not.toBeNull()

    unmount()
    setView('lab')
  })
})
