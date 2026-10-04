/*
 * [add-flat-aux-segmentation T6 / design D6] 参考图层条目测试：
 *   [A] 三态渲染：未生成（占位缩略+徽标「未生成 · 分件用原图」）/在场（真实缩略+
 *       一致性数字+查看大图/重新生成/禁用）/禁用（工件在档徽标+启用）。
 *   [B] 重新生成（mock 恒 autoApprove=立即执行链）：absent→propose→execute→在场，
 *       consistency 行呈现 IoU/模型；结构保护（非可排钻层——无 data-node-id/树行）。
 *   [C] 禁用（确认面+重跑分件提示）：在场→确认→禁用态（分件真源引用回退原图——
 *       blobRef=baseImage 读取语义）；启用→复活。
 * mock 通道（MockAgentApi speed=0）；真实 daemon 行为由 daemon tests/flat-aux-t6.test.ts
 * 锁定（RPC 双模/幂等清/禁用后分件回退集成）。
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
