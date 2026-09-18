/*
[2026-09-19 Test] 改版交互红点（R2–R4 + redesign-studio-layout 方案 A）：
1. 块详情置顶常驻（PM-B3/P0-4：选中即在手边，DOM 顺序先于块列表——检查器内 + 移动端抽屉同构）
2. 底部参数抽屉（R4：上下文条 [块][物理][色板] 入口开 bottom sheet——现行为硬承诺保留）
3. 策略单一真源（PM-B4/P0-2 + 方案 A 不变量：胶片带 chip = 唯一写入点，状态条只读回显）
4. 画布空态双 CTA（add-asset-library 5.1：从素材库选择=主入口（选图器已接线）/ 直接上传=次入口）
5. 上下文条（1.2）：预览模式即时生效；「更换」经 AssetPickerController（add-asset-library 5.1）
6. 状态条（2.3）：违规浮出（红徽标 + 修复直达 + 清单▾）与 spacing 导出门（禁用语义不变）
*/

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import StudioView from '$lib/components/views/StudioView.svelte'
import {
    applyHandoffReference,
    getActiveStrategy,
    getBlocks,
    getExportCheck,
    getPreviewMode,
    getReferenceImage,
    getResults,
    loadFromEngineImage,
    resetStudioForTests,
    selectBlock,
    waitForStudioIdle,
} from '$lib/stores/studio.svelte'
import { getView, setView } from '$lib/stores/view.svelte'
import { fixtureShapes } from '../engine/helpers'
import { ingestAsset, resetAssetStoreForTests, runAssetMigration } from '$lib/persistence/assetStore'
import { installFakeIndexedDB, type FakeIndexedDB } from '../lab/helpers/fakeIndexedDB'

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
  return {
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('工作台 · handoff 参考原图落位（R3 → add-asset-library 5.2 资产化）', () => {
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

    // 已有参考图（手动上传优先）：handoff 不覆盖
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

  it('选中块后详情出现在检查器顶部（先于块列表），且随选中切换更新', async () => {
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

    // 置顶语义：详情在 DOM 顺序上先于块列表（检查器内：详情置顶 → 折叠组含块列表）
    const list = document.querySelector('[data-testid="block-list"]')
    expect(list).not.toBeNull()
    expect(detail!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    unmount()
  })
})

describe('工作台 · 移动端参数抽屉（R4，现行为硬承诺）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('点击「物理」入口打开底部抽屉并渲染物理参数', async () => {
    loadFromEngineImage(fixtureShapes(), 'drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('物理'),
    )
    expect(entry).toBeDefined()
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="param-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.textContent).toContain('物理参数')
    expect(drawer!.textContent).toContain('SS 钻径')
    expect(drawer!.textContent).toContain('gap')

    unmount()
  })

  it('「块」抽屉内含块详情占位/详情、块列表与只读分块参数（PM §4.4 降级）', async () => {
    loadFromEngineImage(fixtureShapes(), 'blocks-drawer.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const entry = [...document.querySelectorAll('[data-testid="mobile-param-entry"] button')].find((b) =>
      b.textContent?.includes('块'),
    )
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const drawer = document.querySelector('[data-testid="param-drawer"]')
    expect(drawer).not.toBeNull()
    expect(drawer!.querySelector('[data-testid="block-list"]')).not.toBeNull()
    // 分块参数只读降级提示（k/seed 编辑回桌面）
    expect(drawer!.textContent).toContain('桌面端调整')

    unmount()
  })
})

describe('工作台 · 策略单一真源（R3 / PM-B4 → 胶片带 2.2 + 状态条 2.3）', () => {
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('状态条只读回显策略（无 Select），点胶片带 chip 即切换导出策略', async () => {
    loadFromEngineImage(fixtureShapes(), 'truth.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const bar = document.querySelector('[data-testid="status-bar"]')
    expect(bar).not.toBeNull()
    // 双真源拆除：状态条内不再有策略下拉（role=combobox）
    expect(bar!.querySelector('[role="combobox"]')).toBeNull()
    expect(bar!.textContent).toContain('策略 ·')

    // 点胶片带 chip（hex-thin）→ 唯一设置入口生效 → 状态条回显切换
    const chip = document.querySelector('[data-testid="strategy-chip-hex-thin"]')
    expect(chip).not.toBeNull()
    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(getActiveStrategy()).toBe('hex-thin')
    const echo = document.querySelector('[data-testid="status-strategy-echo"]')
    expect(echo!.textContent).toContain('六方抽稀')

    // 选中态：chip aria-pressed 且高亮
    expect(chip!.getAttribute('aria-pressed')).toBe('true')

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
  beforeEach(() => {
    resetStudioForTests()
    setView('lab')
  })

  it('点击「叠稿」pill 即时切换预览模式；无参考图时「叠原」禁用', async () => {
    loadFromEngineImage(fixtureShapes(), 'preview.png', 'upload')
    await waitForStudioIdle()
    const { unmount } = await mountStudio()

    const painting = document.querySelector<HTMLButtonElement>('[data-testid="preview-mode-painting"]')
    expect(painting).not.toBeNull()
    painting!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(getPreviewMode()).toBe('painting')

    const reference = document.querySelector<HTMLButtonElement>('[data-testid="preview-mode-reference"]')
    expect(reference).not.toBeNull()
    expect(reference!.disabled).toBe(true)

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

    // 注入违规：把已有钻原位复制一颗（中心距 0 < pitch×0.999 → validate spacing warning；
    // results 是深响应式 $state，代理外写触发 exportCheck 重算）
    const res = getResults().hybrid
    expect(res && !res.error).toBe(true)
    res!.gems.push({ ...res!.gems[0]! })
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
    expect(list!.textContent).toContain('[spacing]')

    // 导出门（语义照搬 ExportBar）：违规阻断三个导出按钮；送精修仍可达（编辑器内可修）
    for (const id of ['export-svg', 'export-bom', 'export-png']) {
      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(btn, `${id} 应存在`).not.toBeNull()
      expect(btn!.disabled, `${id} 违规时应禁用`).toBe(true)
    }
    const send = document.querySelector<HTMLButtonElement>('[data-testid="send-to-edit"]')
    expect(send).not.toBeNull()
    expect(send!.disabled).toBe(false)

    unmount()
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
