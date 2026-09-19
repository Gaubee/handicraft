/**
 * 任务卡蓝图最小子态（TaskCard 展开位——openspec add-lab-drill-params-and-blueprint
 * C 3.3；design §5.3「非画廊重构，仅扩展开位」+ §3.3 徽标列）。
 *
 * 覆盖（tasks 3.3 vitest 口径——四态渲染 + 中断态）：
 * - 成功：缩略图 + 「人审参照 · 非 BOM 数据源」角标 + 完成徽标；无重试/取消动作
 * - 失败：失败徽标（destructive）+ error 文案 + 单独重试按钮（回调缝 onBlueprintAction）
 * - 重试中：pending + retryCount>0 → 「蓝图重试中」+ 单独取消按钮
 * - 旧档无 blueprint：无 stages / 无 blueprint stage → 蓝图区不渲染（收起卡机制零改动）
 * - 中断态（R3 P0）：cancelled + BLUEPRINT_INTERRUPTED_ERROR → 「蓝图已中断，可重试」+ 重试按钮
 * - 收起卡：默认收起态无蓝图区；展开/收起 toggle 不受影响
 *
 * 数据源 = task.stages（LabTask 键位 C3.3 登记、生产归 4.3）经 deriveBlueprintBadge 派生；
 * 测试直接喂 stages fixture（展示骨架口径——数据源接线归 4.4）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'

// jsdom 未实现 ResizeObserver；bits-ui 覆盖层组件内部依赖
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

import type { LabTask } from '$lib/stores/lab.svelte'
import {
  BLUEPRINT_INTERRUPTED_ERROR,
  stageIdOf,
  type LabStage,
} from '$lib/lab/stages'
import { expandEntry, resetGalleryForTests } from '$lib/stores/gallery.svelte'
import TaskCard from '../../components/Lab/TaskCard.svelte'

function baseTask(overrides: Partial<LabTask> = {}): LabTask {
  return {
    id: 'task-bp-1',
    runId: 'run-1',
    variantId: 'ast-tpl-1',
    variantName: '模板A',
    templateAssetId: 'ast-tpl-1',
    candidateIndex: 0,
    prompt: 'prompt body',
    mode: 'generate',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '',
    effectRef: null,
    status: 'success',
    imageUrl: 'blob:mock-main',
    imageStored: true,
    createdAt: 1,
    ...overrides,
  }
}

function mainStage(status: LabStage['status']): LabStage {
  return {
    id: stageIdOf('task-bp-1', 'main'),
    kind: 'main',
    status,
    dependsOn: [],
    imageStored: status === 'success',
    retryCount: 0,
  }
}

function blueprintStage(overrides: Partial<LabStage> = {}): LabStage {
  return {
    id: stageIdOf('task-bp-1', 'blueprint'),
    kind: 'blueprint',
    status: 'pending',
    dependsOn: [stageIdOf('task-bp-1', 'main')],
    imageStored: false,
    retryCount: 0,
    ...overrides,
  }
}

function makeEntry(task: LabTask) {
  return {
    key: `task:${task.id}`,
    live: true,
    task,
    templateName: task.variantName,
    runId: task.runId,
    candidateIndex: task.candidateIndex,
    status: task.status,
    createdAt: task.createdAt,
  }
}

type ActionLog = Array<{ kind: 'retry' | 'cancel'; taskId: string }>

async function mountCard(task: LabTask, actions?: ActionLog) {
  const target = document.createElement('div')
  document.body.append(target)
  const app = mount(TaskCard, {
    target,
    props: {
      entry: makeEntry(task),
      onopenpreview: () => {},
      ...(actions !== undefined
        ? {
            onBlueprintAction: (kind: 'retry' | 'cancel', taskId: string) => {
              actions.push({ kind, taskId })
            },
          }
        : {}),
    },
  })
  expandEntry(`task:${task.id}`)
  await tick()
  return { target, teardown: () => { unmount(app); target.remove() } }
}

function q(target: HTMLDivElement, selector: string): HTMLElement {
  const el = target.querySelector(selector)
  if (!el) throw new Error(`selector not found: ${selector}`)
  return el as HTMLElement
}

beforeEach(() => {
  resetGalleryForTests()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('C3.3 任务卡蓝图子态四态渲染', () => {
  it('成功态：缩略图 + 人审参照角标 + 完成徽标；无重试/取消动作', async () => {
    const task = baseTask({
      stages: [
        mainStage('success'),
        blueprintStage({ status: 'success', imageUrl: 'blob:mock-blueprint', imageStored: true }),
      ],
    })
    const { target, teardown } = await mountCard(task)

    expect(q(target, '[data-testid="task-blueprint"]').textContent).toContain('人审参照 · 非 BOM 数据源')
    expect(q(target, '[data-testid="task-blueprint-badge"]').textContent).toContain('蓝图完成')
    expect((q(target, '[data-testid="task-blueprint-image"]') as HTMLImageElement).src).toBe('blob:mock-blueprint')
    expect(target.querySelector('[data-testid="task-blueprint-retry"]')).toBeNull()
    expect(target.querySelector('[data-testid="task-blueprint-cancel"]')).toBeNull()

    teardown()
  })

  it('失败态：destructive 徽标 + error 文案 + 单独重试按钮（回调缝）', async () => {
    const actions: ActionLog = []
    const task = baseTask({
      status: 'success', // 派生表：main success + blueprint error → 父任务 success（徽标走 stage 面）
      stages: [mainStage('success'), blueprintStage({ status: 'error', error: '蓝图请求超时' })],
    })
    const { target, teardown } = await mountCard(task, actions)

    expect(q(target, '[data-testid="task-blueprint-badge"]').textContent).toContain('蓝图失败')
    expect(q(target, '[data-testid="task-blueprint"]').textContent).toContain('蓝图请求超时')
    expect(target.querySelector('[data-testid="task-blueprint-image"]')).toBeNull()

    q(target, '[data-testid="task-blueprint-retry"]').click()
    expect(actions).toEqual([{ kind: 'retry', taskId: 'task-bp-1' }])
    expect(target.querySelector('[data-testid="task-blueprint-cancel"]')).toBeNull()

    teardown()
  })

  it('重试中：pending + retryCount>0 → 「蓝图重试中」+ 单独取消按钮', async () => {
    const actions: ActionLog = []
    const task = baseTask({
      stages: [mainStage('success'), blueprintStage({ status: 'pending', retryCount: 1 })],
    })
    const { target, teardown } = await mountCard(task, actions)

    expect(q(target, '[data-testid="task-blueprint-badge"]').textContent).toContain('蓝图重试中')
    expect(q(target, '[data-testid="task-blueprint-placeholder"]').textContent).toContain('蓝图重试中')

    q(target, '[data-testid="task-blueprint-cancel"]').click()
    expect(actions).toEqual([{ kind: 'cancel', taskId: 'task-bp-1' }])
    expect(target.querySelector('[data-testid="task-blueprint-retry"]')).toBeNull()

    teardown()
  })

  it('旧档无 blueprint：无 stages / 无 blueprint stage → 蓝图区不渲染', async () => {
    const legacy = await mountCard(baseTask({}))
    expect(legacy.target.querySelector('[data-testid="task-blueprint"]')).toBeNull()
    legacy.teardown()

    // 有 stages 但无 blueprint stage（未启用蓝图的 stage 化任务——4.3 形态）
    const noBlueprintStage = await mountCard(baseTask({ stages: [mainStage('success')] }))
    expect(noBlueprintStage.target.querySelector('[data-testid="task-blueprint"]')).toBeNull()
    noBlueprintStage.teardown()
  })

  it('中断态（R3 P0 刷新恢复）：「蓝图已中断，可重试」徽标 + 重试按钮', async () => {
    const actions: ActionLog = []
    const task = baseTask({
      stages: [
        mainStage('success'),
        blueprintStage({ status: 'cancelled', error: BLUEPRINT_INTERRUPTED_ERROR }),
      ],
    })
    const { target, teardown } = await mountCard(task, actions)

    expect(q(target, '[data-testid="task-blueprint-badge"]').textContent).toContain('蓝图已中断，可重试')
    expect(q(target, '[data-testid="task-blueprint-placeholder"]').textContent).toContain('页面刷新')

    q(target, '[data-testid="task-blueprint-retry"]').click()
    expect(actions).toEqual([{ kind: 'retry', taskId: 'task-bp-1' }])

    teardown()
  })

  it('收起卡零改动：默认收起无蓝图区；toggle 展开后出现', async () => {
    const task = baseTask({
      stages: [mainStage('success'), blueprintStage({ status: 'success', imageUrl: 'blob:mock-blueprint' })],
    })
    const target0 = document.createElement('div')
    document.body.append(target0)
    const app = mount(TaskCard, {
      target: target0,
      props: { entry: makeEntry(task), onopenpreview: () => {} },
    })
    await tick()
    expect(target0.querySelector('[data-testid="entry-expanded"]')).toBeNull()
    expect(target0.querySelector('[data-testid="task-blueprint"]')).toBeNull()

    q(target0, '[data-testid="entry-toggle"]').click()
    await tick()
    expect(target0.querySelector('[data-testid="task-blueprint"]')).toBeTruthy()

    unmount(app)
    target0.remove()
  })
})
