/**
 * 批次分组（runId）语义测试：
 * - 每次点击「开始生成」= 一组：两次 startRun → 两组，组间逆序（最新在前）、组内升序（发起顺序）
 * - 旧数据迁移：无 runId 的持久化任务 → 合成 'legacy' 组（组头「更早」），不崩溃、恢复展示
 * - 重试不产生新组（保持原 runId）；持久化往返带 runId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addVariant,
  getTaskGroups,
  getTasks,
  getVariants,
  hydrate,
  resetLabForTests,
  retryTask,
  startRun,
  updateSettings,
  updateVariant,
} from '$lib/stores/lab.svelte'
import { loadTaskMetas } from '$lib/persistence/taskStore'
import { installFakeIndexedDB, type FakeIndexedDB } from './helpers/fakeIndexedDB'

const B64 = 'aGVsbG8=' // "hello"
const TASKS_KEY = 'rhinestone-studio:tasks'

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let fake: FakeIndexedDB
let objectUrlCounter = 0

beforeEach(() => {
  vi.unstubAllGlobals()
  fake = installFakeIndexedDB()
  fake.reset()
  objectUrlCounter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${(objectUrlCounter += 1)}`),
    revokeObjectURL: vi.fn(),
  })
  localStorage.clear()
  resetLabForTests()
  updateSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.5' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 精简为两个变体：A（2 候选）+ B（1 候选），均解绑案例图走纯 generations 路径。 */
function setupTwoVariants(): { aId: string; bId: string } {
  const first = getVariants()[0]
  for (const v of [...getVariants()]) {
    if (v.id !== first.id) updateVariant(v.id, { enabled: false })
  }
  updateVariant(first.id, { name: 'A', prompt: 'prompt A', candidates: 2, effectRef: null })
  addVariant()
  const b = getVariants().at(-1)!
  updateVariant(b.id, { name: 'B', prompt: 'prompt B', candidates: 1, effectRef: null })
  return { aId: first.id, bId: b.id }
}

/** 旧格式持久化数据（无 runId 字段）——升级前 localStorage 里的真实形态。 */
function oldFormatMeta(i: number) {
  return {
    id: `old-${i}`,
    variantId: 'var-old',
    variantName: `旧变体${i + 1}`,
    candidateIndex: i,
    prompt: `old prompt ${i}`,
    mode: 'generate' as const,
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '',
    status: 'success' as const,
    hasReference: false,
    imageStored: false,
    createdAt: 1_700_000_000_000 + i,
    finishedAt: 1_700_000_001_000 + i,
    durationMs: 1000 + i,
  }
}

describe('批次分组：每次「开始生成」一组', () => {
  it('两次 startRun → 两组：组间逆序（最新在前）、组内升序（变体顺序 × 候选序）', async () => {
    const { aId, bId } = setupTwoVariants()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))

    startRun() // run1：A0 A1 B0
    await waitFor(() => getTasks().length === 3 && getTasks().every((t) => t.status === 'success'))
    startRun() // run2：A0 A1 B0
    await waitFor(() => getTasks().length === 6 && getTasks().every((t) => t.status === 'success'))

    const groups = getTaskGroups()
    expect(groups).toHaveLength(2)

    // 组间：最新批次在前（按组内最新 createdAt 逆序），且两批 runId 互不相同
    const [gNew, gOld] = groups
    expect(gNew.latestCreatedAt).toBeGreaterThan(gOld.latestCreatedAt)
    expect(gNew.runId).not.toBe(gOld.runId)

    for (const g of groups) {
      // 组内：createdAt 严格升序 = 发起顺序稳定
      const cts = g.tasks.map((t) => t.createdAt)
      expect(cts).toEqual([...cts].sort((a, b) => a - b))
      // 组内任务共享同一 runId，且与组 runId 一致
      expect(new Set(g.tasks.map((t) => t.runId)).size).toBe(1)
      expect(g.tasks[0].runId).toBe(g.runId)
      expect(g.legacy).toBe(false)
    }

    // 组内原始顺序：变体 A 的候选 0/1 → 变体 B 的候选 0
    const orderOf = (g: (typeof groups)[number]) =>
      g.tasks.map((t) => (t.variantId === aId ? 'A' : t.variantId === bId ? 'B' : '?') + t.candidateIndex)
    expect(orderOf(gOld)).toEqual(['A0', 'A1', 'B0'])
    expect(orderOf(gNew)).toEqual(['A0', 'A1', 'B0'])

    // 新批次是后发起的（run1 在前创建）
    expect(gOld.tasks[0].createdAt).toBeLessThan(gNew.tasks[0].createdAt)

    // 批次序号：总序号（创建先后），旧批次 = 第 1 次、新批次 = 第 2 次
    expect(gOld.runIndex).toBe(1)
    expect(gNew.runIndex).toBe(2)

    // 组头信息字段：时间取组内最早 createdAt（发起时刻）
    expect(gOld.startedAt).toBe(Math.min(...gOld.tasks.map((t) => t.createdAt)))
    expect(gNew.startedAt).toBe(Math.min(...gNew.tasks.map((t) => t.createdAt)))
  })

  it('同毫秒内连续两次 startRun 也不并组（runId 含自增序号）', async () => {
    setupTwoVariants()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const r1 = startRun()
    const r2 = startRun()
    expect(r1.ok && r2.ok).toBe(true)
    const runIds = new Set(getTasks().map((t) => t.runId))
    expect(runIds.size).toBe(2)
  })
})

describe('旧数据迁移（无 runId → legacy 合成组）', () => {
  it('loadTaskMetas：无 runId 字段归一为 legacy', () => {
    localStorage.setItem(TASKS_KEY, JSON.stringify([oldFormatMeta(0), oldFormatMeta(1)]))
    const metas = loadTaskMetas()
    expect(metas).toHaveLength(2)
    expect(metas.every((m) => m.runId === 'legacy')).toBe(true)
  })

  it('hydrate 恢复旧数据 → 单个 legacy 组不崩溃、任务齐全；legacy 不占「第 N 次」编号', async () => {
    localStorage.setItem(TASKS_KEY, JSON.stringify([oldFormatMeta(0), oldFormatMeta(1)]))
    await hydrate()
    expect(getTasks()).toHaveLength(2)

    const groups = getTaskGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].runId).toBe('legacy')
    expect(groups[0].legacy).toBe(true)
    expect(groups[0].runIndex).toBeUndefined()
    expect(groups[0].tasks).toHaveLength(2)
    // 组内仍按 createdAt 升序
    const cts = groups[0].tasks.map((t) => t.createdAt)
    expect(cts).toEqual([...cts].sort((a, b) => a - b))
  })

  it('legacy 组与新 run 并存：新组在前（最新在前），legacy 在末尾且新批次从第 1 次起编号', async () => {
    localStorage.setItem(TASKS_KEY, JSON.stringify([oldFormatMeta(0)]))
    await hydrate()

    // 发起一轮新 run（单变体单候选聚焦）
    const first = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== first.id) updateVariant(v.id, { enabled: false })
    }
    updateVariant(first.id, { prompt: 'new prompt', candidates: 1, effectRef: null })
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().every((t) => t.status === 'success'))

    const groups = getTaskGroups()
    expect(groups).toHaveLength(2)
    expect(groups[0].legacy).toBe(false)
    expect(groups[0].runIndex).toBe(1) // legacy 不占号：新批次是「第 1 次运行」
    expect(groups[1].legacy).toBe(true)
    expect(groups[1].runIndex).toBeUndefined()
  })
})

describe('重试与持久化往返', () => {
  it('失败重试保持原 runId：不产生新组', async () => {
    const first = getVariants()[0]
    for (const v of [...getVariants()]) {
      if (v.id !== first.id) updateVariant(v.id, { enabled: false })
    }
    updateVariant(first.id, { prompt: 'retry keeps group', candidates: 1, effectRef: null })

    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return call === 1 ? errorResponse(500, 'boom') : okResponse()
      }),
    )
    startRun()
    await waitFor(() => getTasks()[0]?.status === 'error')

    const runIdBefore = getTasks()[0].runId
    retryTask(getTasks()[0].id)
    await waitFor(() => getTasks()[0]?.status === 'success')

    expect(getTasks()[0].runId).toBe(runIdBefore)
    expect(getTaskGroups()).toHaveLength(1)
    expect(getTaskGroups()[0].tasks).toHaveLength(1)
  })

  it('持久化往返带 runId：刷新恢复后仍两组、组间逆序保持', async () => {
    setupTwoVariants()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    startRun()
    await waitFor(() => getTasks().length === 3 && getTasks().every((t) => t.status === 'success'))
    startRun()
    // 持久化在归档链（runTx 等 oncomplete 真提交）落定后的 finally 里发生——
    // waitFor 需同步等待 localStorage 落盘，而非只等内存态 success。
    await waitFor(
      () =>
        getTasks().length === 6 &&
        getTasks().every((t) => t.status === 'success') &&
        (JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as { runId?: string }[]).length === 6,
    )

    // localStorage 落盘：全部带 run- 前缀 runId，且恰好两个批次
    const persisted = JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as { runId?: string }[]
    expect(persisted).toHaveLength(6)
    expect(persisted.every((t) => typeof t.runId === 'string' && t.runId.startsWith('run-'))).toBe(true)
    expect(new Set(persisted.map((t) => t.runId)).size).toBe(2)

    const runIdsBefore = getTaskGroups().map((g) => g.runId)

    // 模拟刷新
    resetLabForTests()
    await hydrate()
    const groups = getTaskGroups()
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.runId)).toEqual(runIdsBefore) // runId 往返保真（顺序 = 逆序保持）
    expect(groups.every((g) => !g.legacy)).toBe(true)
  })
})
