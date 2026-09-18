import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTaskMetas,
  loadLabForm,
  loadTaskMetas,
  loadVariants,
  saveLabForm,
  saveTaskMetas,
  saveVariants,
  type PersistedTaskMeta,
} from '$lib/persistence/taskStore'
import { loadSettings, saveSettings } from '$lib/api/settings'

const TASKS_KEY = 'rhinestone-studio:tasks'
const SETTINGS_KEY = 'rhinestone-studio:settings'

function makeTask(index: number, withDebug: boolean): PersistedTaskMeta {
  return {
    id: `task-${index}`,
    variantId: `var-${index % 3}`,
    variantName: `变体${(index % 3) + 1}`,
    candidateIndex: index % 2,
    prompt: `prompt ${index}`,
    mode: index % 2 === 0 ? 'generate' : 'edit',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '',
    status: 'success',
    hasReference: index % 2 === 1,
    imageStored: true,
    createdAt: 1_700_000_000_000 + index,
    finishedAt: 1_700_000_001_000 + index,
    durationMs: 1234 + index,
    ...(withDebug
      ? {
          debug: {
            endpoint: `https://relay.example.com/v1/images/generations`,
            requestBody: { model: 'gpt-image-2.5', n: 1 },
            responseStatus: 200,
            responseBodyText: 'x'.repeat(900),
          },
        }
      : {}),
  }
}

let setItemSpy: ReturnType<typeof vi.spyOn> | null = null

const originalSetItem = Storage.prototype.setItem

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  setItemSpy = null
  localStorage.clear()
})

/** 模拟配额异常：predicate 为真时 setItem 抛 QuotaExceeded。 */
function mockQuotaExceededOn(predicate: (key: string, value: string) => boolean): void {
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (predicate(key, value)) throw new DOMException('mock quota exceeded', 'QuotaExceededError')
    originalSetItem.call(this, key, value)
  })
}

describe('任务元数据三级配额降级', () => {
  it('L1：配额充足时全量写入（含 debug）', () => {
    const tasks = [makeTask(0, true), makeTask(1, true)]
    const outcome = saveTaskMetas(tasks)
    expect(outcome.level).toBe('full')
    const stored = JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as PersistedTaskMeta[]
    expect(stored).toHaveLength(2)
    expect(stored[0].debug).toBeDefined()
  })

  it('L2：含 payload 写入抛配额时剥 debug 重试', () => {
    const tasks = [makeTask(0, true), makeTask(1, true)]
    mockQuotaExceededOn((_key, value) => value.includes('"debug"'))
    const outcome = saveTaskMetas(tasks)
    expect(outcome.level).toBe('no-payload')
    const stored = JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as PersistedTaskMeta[]
    expect(stored).toHaveLength(2)
    expect(stored[0].debug).toBeUndefined()
    // 任务史本身保留（提示词/耗时/状态）
    expect(stored[0].prompt).toBe('prompt 0')
    expect(stored[0].status).toBe('success')
  })

  it('L3：剥 payload 仍超配额时只留最近 50 条', () => {
    const tasks = Array.from({ length: 120 }, (_, i) => makeTask(i, false))
    // 计算恰好容纳「最近 50 条（无 debug）」的阈值
    const allowed = JSON.stringify(tasks.slice(-50))
    mockQuotaExceededOn((_key, value) => value.length > allowed.length)

    const outcome = saveTaskMetas(tasks)
    expect(outcome.level).toBe('recent-50')
    const stored = JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as PersistedTaskMeta[]
    expect(stored).toHaveLength(50)
    expect(stored[0].id).toBe('task-70')
    expect(stored[49].id).toBe('task-119')
  })

  it('L4：三级全部失败也不抛出（生成流程不受打断）', () => {
    mockQuotaExceededOn(() => true)
    const outcome = saveTaskMetas([makeTask(0, true)])
    expect(outcome.level).toBe('failed')
  })

  it('任何降级都不触碰设置：设置在任务配额爆炸后保持', () => {
    saveSettings({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-keep', model: 'gpt-image-2.5' })
    // 任务的 setItem 永远失败
    mockQuotaExceededOn((key) => key === TASKS_KEY)
    const outcome = saveTaskMetas(Array.from({ length: 80 }, (_, i) => makeTask(i, true)))
    expect(outcome.level).not.toBe('full')
    // 设置独立 key，完好无损
    const settings = loadSettings()
    expect(settings.baseUrl).toBe('https://relay.example.com/v1')
    expect(settings.apiKey).toBe('sk-keep')
    expect(localStorage.getItem(SETTINGS_KEY)).toContain('sk-keep')
  })
})

describe('任务元数据读取', () => {
  it('roundtrip：写入后读取结构一致', () => {
    saveTaskMetas([makeTask(1, true)])
    const loaded = loadTaskMetas()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('task-1')
    expect(loaded[0].mode).toBe('edit')
    expect(loaded[0].debug?.endpoint).toContain('/images/generations')
  })

  it('损坏数据过滤为空数组', () => {
    localStorage.setItem(TASKS_KEY, '{bad')
    expect(loadTaskMetas()).toEqual([])
    localStorage.setItem(TASKS_KEY, JSON.stringify([{ id: 1 }]))
    expect(loadTaskMetas()).toEqual([])
  })

  it('clearTaskMetas 清空', () => {
    saveTaskMetas([makeTask(0, false)])
    clearTaskMetas()
    expect(localStorage.getItem(TASKS_KEY)).toBeNull()
  })
})

describe('变体与表单持久化', () => {
  it('变体 roundtrip 与候选数 clamp', () => {
    saveVariants([
      { id: 'v1', name: '严格扁平', prompt: 'flat', candidates: 2, enabled: true },
      { id: 'v2', name: '描边', prompt: 'outline', candidates: 99, enabled: true },
    ])
    const loaded = loadVariants()
    expect(loaded).not.toBeNull()
    expect(loaded?.[0].name).toBe('严格扁平')
    expect(loaded?.[1].candidates).toBe(8)
  })

  it('变体配额异常静默失败（返回 false），不影响设置', () => {
    mockQuotaExceededOn((key) => key === 'rhinestone-studio:variants')
    expect(saveVariants([{ id: 'v1', name: 'x', prompt: 'y', candidates: 2, enabled: true }])).toBe(false)
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull() // 没有误写别的 key
  })

  it('表单 roundtrip', () => {
    saveLabForm({ advancedJson: '{"background":"transparent"}', size: '1024x1024' })
    const loaded = loadLabForm()
    expect(loaded?.advancedJson).toBe('{"background":"transparent"}')
    expect(loaded?.size).toBe('1024x1024')
  })
})
