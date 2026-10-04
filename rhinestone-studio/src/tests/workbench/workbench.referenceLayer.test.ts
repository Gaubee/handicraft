/*
 * [add-flat-aux-segmentation T6 / design D6] 参考图层条目测试：
 *   [A] 三态渲染：未生成（占位缩略+徽标「未生成 · 分件用原图」）/在场（真实缩略+
 *       一致性数字+查看大图/重新生成/禁用）/禁用（工件在档徽标+启用）。
 *   [B] 重新生成（mock 恒 autoApprove=立即执行链）：absent→propose→execute→在场，
 *       consistency 行呈现 IoU/模型；结构保护（非可排钻层——无 data-node-id/树行）。
 *   [C] 禁用（确认面+重跑分件提示）：在场→确认→禁用态（分件真源引用回退原图——
 *       blobRef=baseImage 读取语义）；启用→复活。
 *   [D] 手动导入（T6.3 BYOK）：hidden file input→上传（mock=演示 ref）→import→
 *       在场态（consistency model=manual-import）；门不过=typed 拒就地呈现
 *       （IoU 数字在场，UI 保持 absent）。
 * mock 通道（MockAgentApi speed=0）；真实 daemon 行为由 daemon tests/flat-aux-t6.test.ts
 * 与 tests/flat-aux-t6-import.test.ts 锁定（RPC 双模/幂等清/禁用后分件回退/导入门与归属）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID, WORKBENCH_FIXTURE_BLOB_REFS } from '$lib/agentApi/workbenchFixtures'
import {
  bindAgentApi,
  getBoundAgentApi,
  initAgentStore,
  resetAgentStoreForTests,
} from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import { getWorkbenchReferenceLayer } from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetCanvasStageForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetWorkbenchForTests } from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

const mountedDisposers: Array<() => void> = []

function mountView<P extends Record<string, unknown>>(component: Component<P>, props: Partial<P> = {}): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = mount(component, { target, props: props as P })
  mountedDisposers.push(() => {
    unmount(instance)
    target.remove()
  })
}

async function flush(ms = 20): Promise<void> {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await flush(20)
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

function qq(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
}

function click(selector: string): void {
  const el = q(selector)
  if (el === null) throw new Error(`元素不存在：${selector}`)
  el.click()
}

/** mock 工作台内部 detail 透镜（断言 blobRef 回退语义——与服务端读取语义同构）。 */
function referenceLens(): { blobRef: string; generated: boolean; disabled?: boolean; referenceBlobRef?: string } | null {
  const api = getBoundAgentApi() as MockAgentApi
  const states = (api as unknown as { workbenchStates: Map<string, { detail: { referenceImage: ReturnType<typeof referenceLens> } }> }).workbenchStates
  const state = states.get(WORKBENCH_FIXTURE_TASK_ID)
  return state?.detail.referenceImage ?? null
}

beforeEach(async () => {
  localStorage.clear()
  resetAgentStoreForTests()
  resetWorkbenchForTests()
  resetCanvasStageForTests()
  resetViewForTests('studio')
  resetToastsForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
  await initAgentStore()
})

afterEach(() => {
  mountedDisposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('T6 参考图层条目（D6 三态+操作流）', () => {
  vi.setConfig({ testTimeout: 20_000 })

  async function mountAndWait(): Promise<void> {
    mountView(TaskWorkbenchView, { taskId: WORKBENCH_FIXTURE_TASK_ID })
    await waitUntil(() => qq('[data-testid="workbench-layer-row"]').length === 5)
  }

  /** [A] 三态渲染
   */
  it('未生成态：面板顶部条目+占位缩略+「未生成 · 分件用原图」徽标；操作仅重新生成', async () => {
    await mountAndWait()
    const entry = q('[data-testid="workbench-reference-layer"]')
    expect(entry).not.toBeNull()
    expect(entry!.getAttribute('data-state')).toBe('absent')
    // 面板顶部：条目在图层树行之前（DOM 序）
    const tree = q('[data-testid="workbench-layer-tree"]')
    expect(tree!.compareDocumentPosition(entry!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(q('[data-testid="workbench-reference-thumb-placeholder"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-thumb"]')).toBeNull()
    expect(q('[data-testid="workbench-reference-badge"]')?.textContent).toContain('未生成')
    expect(q('[data-testid="workbench-reference-badge"]')?.textContent).toContain('分件用原图')
    expect(q('[data-testid="workbench-reference-regenerate"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-disable"]')).toBeNull()
    expect(q('[data-testid="workbench-reference-enable"]')).toBeNull()
    expect(q('[data-testid="workbench-reference-view"]')).toBeNull()
    // 结构保护：非可排钻层——不携带 data-node-id（不进树行/选择/拖拽面）
    expect(entry!.getAttribute('data-node-id')).toBeNull()
    expect(entry!.getAttribute('aria-label')).toContain('非可排钻层')
  })

  it('重新生成（mock autoApprove 立即执行链）：absent→propose→execute→在场态（缩略+一致性数字+禁用入口）', async () => {
    await mountAndWait()
    click('[data-testid="workbench-reference-regenerate"]')
    await waitUntil(() => q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state') === 'active')
    // 在场三面：真实缩略+徽标+一致性行（IoU 0.93 · mock-image-edit）
    expect(q('[data-testid="workbench-reference-thumb"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-badge"]')?.textContent).toContain('生效中')
    expect(q('[data-testid="workbench-reference-badge"]')?.textContent).toContain('分件真源')
    const consistency = q('[data-testid="workbench-reference-consistency"]')
    expect(consistency?.textContent).toContain('0.930')
    expect(consistency?.textContent).toContain('mock-image-edit')
    expect(q('[data-testid="workbench-reference-view"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-disable"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-enable"]')).toBeNull()
    // store 读面：分件真源引用=生成工件本体（blobRef=referenceBlobRef）
    const reference = getWorkbenchReferenceLayer()
    expect(reference).toMatchObject({ generated: true })
    expect(reference?.blobRef).toBe(reference?.referenceBlobRef)
    expect(reference?.blobRef).not.toBe(WORKBENCH_FIXTURE_BLOB_REFS.baseImage)
  })

  /** [D] 手动导入（T6.3 BYOK——file input 注入形态与 composerAttachments 同款） */
  it('导入成功（mock 面）：absent→选文件→import 生效→在场态（consistency 行 model=manual-import）', async () => {
    await mountAndWait()
    expect(q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state')).toBe('absent')
    const input = q('[data-testid="workbench-reference-import-file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    // mock 演示模式无上传面——组件落 demo- ref，mock import 不消费字节（演示链路完整）
    Object.defineProperty(input!, 'files', {
      value: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'flat.png', { type: 'image/png' })],
      configurable: true,
    })
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await waitUntil(() => q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state') === 'active')
    // 在场+导入判别面：consistency 行携 manual-import（与生成路 mock-image-edit 可区分）
    const consistency = q('[data-testid="workbench-reference-consistency"]')
    expect(consistency?.textContent).toContain('0.930')
    expect(consistency?.textContent).toContain('manual-import')
    expect(q('[data-testid="workbench-reference-import-message"]')).toBeNull()
    const reference = getWorkbenchReferenceLayer()
    expect(reference).toMatchObject({ generated: true })
    expect(reference?.blobRef).toBe(reference?.referenceBlobRef)
  })

  it('导入门不过：typed 拒就地呈现（IoU 数字在场）——条目保持 absent 不生效', async () => {
    await mountAndWait()
    const api = getBoundAgentApi() as MockAgentApi
    const spy = vi.spyOn(api, 'taskReferenceImport').mockRejectedValue(
      new Error(
        '导入图未过几何一致性门：剪影 IoU 0.595 < 0.85（原图前景 25.4% vs 参考图层 25.4%）——参考图层轮廓漂移，弃用回退原图（工件保留供人审）',
      ),
    )
    const input = q('[data-testid="workbench-reference-import-file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    Object.defineProperty(input!, 'files', {
      value: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shifted.png', { type: 'image/png' })],
      configurable: true,
    })
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await waitUntil(() => q('[data-testid="workbench-reference-import-message"]') !== null)
    const message = q('[data-testid="workbench-reference-import-message"]')!
    expect(message.getAttribute('role')).toBe('alert')
    expect(message.textContent).toContain('导入失败')
    expect(message.textContent).toMatch(/IoU 0\.\d+/)
    // 门不过=不生效：条目保持未生成态（分件继续用原图）
    expect(q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state')).toBe('absent')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('禁用（确认面+重跑分件提示）：blobRef 回退原图+工件在档；启用→复活', async () => {
    await mountAndWait()
    click('[data-testid="workbench-reference-regenerate"]')
    await waitUntil(() => q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state') === 'active')

    // 禁用=破坏性语义：先确认面（重跑分件提示就近呈现），未确认不生效
    click('[data-testid="workbench-reference-disable"]')
    await flush()
    const confirm = q('[data-testid="workbench-reference-disable-confirm"]')
    expect(confirm).not.toBeNull()
    expect(confirm?.textContent).toContain('分件')
    expect(q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state')).toBe('active')

    click('[data-testid="workbench-reference-disable-confirm-ok"]')
    await waitUntil(() => q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state') === 'disabled')
    // 禁用态三面：徽标已禁用·分件用原图；缩略（工件在档）仍在；启用入口在场
    expect(q('[data-testid="workbench-reference-badge"]')?.textContent).toContain('已禁用')
    expect(q('[data-testid="workbench-reference-thumb"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-enable"]')).not.toBeNull()
    expect(q('[data-testid="workbench-reference-disable"]')).toBeNull()
    // 读取语义（与 daemon task.detail 投影同构）：分件真源引用回退原图+工件仍指本体
    const disabled = getWorkbenchReferenceLayer()
    expect(disabled).toMatchObject({ generated: true, disabled: true })
    expect(disabled?.blobRef).toBe(WORKBENCH_FIXTURE_BLOB_REFS.baseImage)
    expect(disabled?.referenceBlobRef).not.toBe(WORKBENCH_FIXTURE_BLOB_REFS.baseImage)
    expect(referenceLens()?.blobRef).toBe(WORKBENCH_FIXTURE_BLOB_REFS.baseImage)

    // 启用：复活（blobRef 复指工件本体）
    click('[data-testid="workbench-reference-enable"]')
    await waitUntil(() => q('[data-testid="workbench-reference-layer"]')?.getAttribute('data-state') === 'active')
    const revived = getWorkbenchReferenceLayer()
    expect(revived?.blobRef).toBe(revived?.referenceBlobRef)
    expect(revived?.disabled).toBeUndefined()
  })

  it('查看大图：在场态展开/收起内联大图（工件字节经附件通道）', async () => {
    await mountAndWait()
    click('[data-testid="workbench-reference-regenerate"]')
    await waitUntil(() => q('[data-testid="workbench-reference-view"]') !== null)
    expect(q('[data-testid="workbench-reference-large"]')).toBeNull()
    click('[data-testid="workbench-reference-view"]')
    await waitUntil(() => q('[data-testid="workbench-reference-large"]') !== null)
    const img = q('[data-testid="workbench-reference-large"] img')
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    click('[data-testid="workbench-reference-view"]')
    await flush()
    expect(q('[data-testid="workbench-reference-large"]')).toBeNull()
  })
})
