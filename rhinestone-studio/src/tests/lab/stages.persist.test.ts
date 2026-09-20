/**
 * 轨 B 2.3：PersistedTaskMeta stage 持久化（terminal-only）+ legacy 合成 + 配额降级保全 +
 * 刷新 fixture（design §3.3 刷新持久化策略七条——R3 P0 验收）：
 * ① main pending/running 刷新（活动 stage 丢弃不落账本）；
 * ② main success + blueprint running 刷新（终态恢复 +「蓝图已中断，可重试」派生态）；
 * ③ 失败后重试（新 requestId 不复用——跨持久化边界）；
 * ④ 保存/恢复边界（requestId/assetId/drillParams/blueprint/materialAssetIds 快照保全）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BLUEPRINT_INTERRUPTED_ERROR,
  createTaskStages,
  deriveBlueprintBadge,
  deriveTaskStatus,
  persistedTaskStatusOf,
  reduceStages,
  schedulableStages,
  stageIdOf,
  stagesFromPersisted,
  stagesToPersisted,
  type LabStage,
  type LabTaskDrillParams,
} from '$lib/lab/stages'
import { loadTaskMetas, saveTaskMetas, type PersistedTaskMeta } from '$lib/persistence/taskStore'

const TASKS_KEY = 'rhinestone-studio:tasks'
const BASE_TIME = 1_700_000_000_000

const MAIN = stageIdOf('task-1', 'main')
const BP = stageIdOf('task-1', 'blueprint')

const originalSetItem = Storage.prototype.setItem

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

function serialTree(): LabStage[] {
  return createTaskStages('task-1', { strategy: 'serial' })
}

function at(stages: LabStage[], stageId: string): LabStage {
  const found = stages.find((s) => s.id === stageId)
  if (found === undefined) throw new Error(`stage 不存在：${stageId}`)
  return found
}

function dispatchAndSucceed(stages: LabStage[], stageId: string, requestId: string, product?: { assetId?: string }): LabStage[] {
  let next = reduceStages(stages, { type: 'dispatch', stageId, requestId })
  if (product !== undefined) {
    next = next.map((s) => (s.id === stageId ? { ...s, ...product, imageStored: product.assetId !== undefined } : s))
  }
  return reduceStages(next, { type: 'succeed', stageId })
}

const drillParams: LabTaskDrillParams = {
  specs: [
    { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
    { specKey: 'custom-ast-9', ordinal: 2, shapeId: 'custom', sizeLabel: 'C-star01', diameterMm: 5.0, assetId: 'ast-9' },
  ],
  physical: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
  materialAssetIds: ['ast-9'],
}

const blueprintSnapshot = { strategy: 'serial' as const, refs: ['ast-r1'] }

function makeMeta(over: Partial<PersistedTaskMeta>): PersistedTaskMeta {
  return {
    id: 'task-1',
    runId: 'run-1',
    variantId: 'var-1',
    variantName: '变体1',
    candidateIndex: 0,
    prompt: 'prompt',
    mode: 'edit',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '',
    status: 'success',
    hasReference: true,
    imageStored: true,
    createdAt: BASE_TIME,
    ...over,
  }
}

/** 模拟 4.x persistTasks 的 stage 侧写面：persistedTaskStatusOf 门 + 终态投影 + 参数快照。 */
function metaOfStageTask(
  stages: LabStage[],
  over: Partial<PersistedTaskMeta> = {},
): PersistedTaskMeta | null {
  const status = persistedTaskStatusOf(stages)
  if (status === null) return null
  return makeMeta({
    status,
    stages: stagesToPersisted(stages),
    ...(at(stages, MAIN).assetId !== undefined ? { assetId: at(stages, MAIN).assetId } : {}),
    drillParams,
    blueprint: blueprintSnapshot,
    ...over,
  })
}

/** 模拟 4.x hydrate 的 stage 侧读面：账本 meta → LabStage[]。 */
function restoreFrom(meta: PersistedTaskMeta): LabStage[] {
  return stagesFromPersisted(meta.id, {
    status: meta.status,
    assetId: meta.assetId,
    error: meta.error,
    imageStored: meta.imageStored,
    finishedAt: meta.finishedAt,
    durationMs: meta.durationMs,
    stages: meta.stages,
    hasBlueprint: meta.blueprint !== undefined,
    blueprintStrategy: meta.blueprint?.strategy,
  })
}

describe('round-trip：终态快照保存/恢复（fixture ④的 stage 半边）', () => {
  it('双 stage 终态树：requestId/assetId/retryCount/imageStored/时间戳全量往返', () => {
    let stages = dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' })
    // blueprint 失败一次再重试成功（retryCount=1 落账本）
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'req-bp-1' })
    stages = reduceStages(stages, { type: 'fail', stageId: BP, error: '蓝图糊字' })
    stages = reduceStages(stages, { type: 'retry', stageId: BP })
    stages = dispatchAndSucceed(stages, BP, 'req-bp-2', { assetId: 'ast-bp' })

    const meta = metaOfStageTask(stages)
    expect(meta).not.toBeNull()
    saveTaskMetas([meta as PersistedTaskMeta])
    const loaded = loadTaskMetas()
    expect(loaded).toHaveLength(1)
    const restored = restoreFrom(loaded[0])

    expect(at(restored, MAIN).status).toBe('success')
    expect(at(restored, MAIN).requestId).toBe('req-main-1')
    expect(at(restored, MAIN).assetId).toBe('ast-main')
    expect(at(restored, MAIN).imageStored).toBe(true)
    expect(at(restored, BP).status).toBe('success')
    expect(at(restored, BP).requestId).toBe('req-bp-2')
    expect(at(restored, BP).assetId).toBe('ast-bp')
    expect(at(restored, BP).retryCount).toBe(1)
    expect(at(restored, BP).dependsOn).toEqual([MAIN])
    expect(deriveTaskStatus(restored)).toBe('success')
    expect(deriveBlueprintBadge(restored)).toBe('success')
  })

  it('瞬态字段不落账本：stage 投影无 imageUrl/debug 键', () => {
    let stages = dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' })
    stages = stages.map((s) => (s.id === MAIN ? { ...s, imageUrl: 'blob:main', debug: { endpoint: 'https://x', requestBody: {} } } : s))
    const persisted = stagesToPersisted(stages)
    expect(persisted).toHaveLength(1)
    expect(Object.keys(persisted[0]).sort()).toEqual(
      ['assetId', 'dependsOn', 'durationMs', 'finishedAt', 'id', 'imageStored', 'kind', 'requestId', 'retryCount', 'startedAt', 'status'].sort(),
    )
  })

  it('参数快照往返：drillParams（specs/physical/materialAssetIds）与 blueprint（strategy/refs）逐字段等价', () => {
    const meta = metaOfStageTask(dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' }))
    saveTaskMetas([meta as PersistedTaskMeta])
    const [loaded] = loadTaskMetas()
    expect(loaded.drillParams).toEqual(drillParams)
    expect(loaded.drillParams?.materialAssetIds).toEqual(['ast-9'])
    expect(loaded.blueprint).toEqual(blueprintSnapshot)
  })

  // —— [R5-P1 统一契约] 脏账本拒读：custom 快照缺 assetId → 整份 drillParams 丢弃（镜像 W0 反向约束）——
  it('脏账本拒读：custom spec 缺 assetId 的 drillParams 整份丢弃（任务本体保留）', () => {
    const dirty = metaOfStageTask(dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' }), {
      drillParams: {
        specs: [
          { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
          // custom 无 assetId：无法解析素材的规格——拒读，不恢复半份清单（ordinal 会说谎）
          { specKey: 'custom-orphan', ordinal: 2, shapeId: 'custom', sizeLabel: 'C-star01', diameterMm: 5.0 },
        ],
        materialAssetIds: [],
      },
    })
    saveTaskMetas([dirty as PersistedTaskMeta])
    const [loaded] = loadTaskMetas()
    expect(loaded.drillParams).toBeUndefined()
    expect(loaded.id).toBe('task-1') // 任务本体不丢（丢字段不丢任务）
    // 镜像对照：同清单补上 assetId 即恢复
    const clean = metaOfStageTask(dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' }), {
      drillParams: {
        specs: [
          { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
          { specKey: 'custom-ast-9', ordinal: 2, shapeId: 'custom', sizeLabel: 'C-star01', diameterMm: 5.0, assetId: 'ast-9' },
        ],
        materialAssetIds: [],
      },
    })
    saveTaskMetas([clean as PersistedTaskMeta])
    const [loadedClean] = loadTaskMetas()
    expect(loadedClean.drillParams?.specs).toHaveLength(2)
  })

  // —— [R6 P2-1] 脏账本重复 id 恢复去重：materialAssetIds Set 去重（首见序）——
  it('脏账本 materialAssetIds 重复 id → 恢复去重（首见序；过滤与去重叠加）', () => {
    const dirty = metaOfStageTask(dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' }), {
      drillParams: {
        ...drillParams,
        // 脏账本：重复 id + 非字符串项 + 空串——过滤后 Set 去重（重复附图/双份配额计算偏差防线）
        materialAssetIds: ['ast-9', 'ast-7', 'ast-9', 42, '', 'ast-7', 'ast-9'],
      },
    })
    saveTaskMetas([dirty as PersistedTaskMeta])
    const [loaded] = loadTaskMetas()
    expect(loaded.drillParams?.materialAssetIds).toEqual(['ast-9', 'ast-7'])
    // specs/physical 不受影响（去重只作用于素材附图清单）
    expect(loaded.drillParams?.specs).toEqual(drillParams.specs)
    expect(loaded.drillParams?.physical).toEqual(drillParams.physical)
  })
})

describe('legacy 账本（无 stages）读时合成单 main stage（只读兼容）', () => {
  it('legacy success：顶层 assetId/finishedAt/durationMs 合成 main（startedAt 派生），无 blueprint', () => {
    const legacy = makeMeta({ status: 'success', assetId: 'ast-old', imageStored: true, finishedAt: BASE_TIME + 5_000, durationMs: 5_000 })
    const restored = restoreFrom(legacy)
    expect(restored).toHaveLength(1)
    expect(at(restored, MAIN).kind).toBe('main')
    expect(at(restored, MAIN).status).toBe('success')
    expect(at(restored, MAIN).assetId).toBe('ast-old')
    expect(at(restored, MAIN).startedAt).toBe(BASE_TIME)
    expect(at(restored, MAIN).finishedAt).toBe(BASE_TIME + 5_000)
    expect(at(restored, MAIN).retryCount).toBe(0)
    expect(deriveTaskStatus(restored)).toBe('success')
    expect(deriveBlueprintBadge(restored)).toBeNull()
  })

  it('legacy error/cancelled：同路径合成对应终态', () => {
    for (const status of ['error', 'cancelled'] as const) {
      const legacy = makeMeta({ status, error: status === 'error' ? '旧错误' : '已取消', imageStored: false })
      const restored = restoreFrom(legacy)
      expect(at(restored, MAIN).status).toBe(status)
      expect(deriveTaskStatus(restored)).toBe(status)
    }
  })

  it('loadTaskMetas 对无 stages 的 legacy meta：stages 字段保持 undefined（不误造）', () => {
    saveTaskMetas([makeMeta({ status: 'success', assetId: 'ast-old' })])
    const [loaded] = loadTaskMetas()
    expect(loaded.stages).toBeUndefined()
  })
})

describe('刷新 fixture（R3 P0）', () => {
  it('① main pending / main running 刷新：活动 stage 丢弃，不落账本', () => {
    for (const status of ['pending', 'running'] as const) {
      const stages = status === 'pending' ? serialTree() : reduceStages(serialTree(), { type: 'dispatch', stageId: MAIN, requestId: 'r' })
      expect(persistedTaskStatusOf(stages)).toBeNull()
      expect(stagesToPersisted(stages)).toEqual([])
      // 4.x persistTasks 门：不落账本（本批无其他任务 → 账本空）
      const persistable = [metaOfStageTask(stages)].filter((m): m is PersistedTaskMeta => m !== null)
      saveTaskMetas(persistable)
      expect(loadTaskMetas()).toEqual([])
    }
  })

  it('② main success + blueprint running 刷新：终态恢复 +「蓝图已中断，可重试」派生态', () => {
    let stages = dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' })
    stages = reduceStages(stages, { type: 'dispatch', stageId: BP, requestId: 'req-bp-1' })
    expect(at(stages, BP).status).toBe('running')

    // 刷新前落账：只 main 终态落账本，blueprint 活动态丢弃
    const meta = metaOfStageTask(stages)
    expect(meta?.status).toBe('success')
    expect(meta?.stages).toHaveLength(1)
    expect(meta?.stages?.[0].id).toBe(MAIN)
    saveTaskMetas([meta as PersistedTaskMeta])

    // 刷新后恢复：main success 原样 + blueprint 合成中断态
    const [loaded] = loadTaskMetas()
    const restored = restoreFrom(loaded)
    expect(at(restored, MAIN).status).toBe('success')
    expect(at(restored, MAIN).assetId).toBe('ast-main')
    expect(at(restored, MAIN).requestId).toBe('req-main-1')
    expect(deriveTaskStatus(restored)).toBe('success') // 父任务不挂 running（无活动 controller）
    expect(deriveBlueprintBadge(restored)).toBe('interrupted')
    expect(at(restored, BP).error).toBe(BLUEPRINT_INTERRUPTED_ERROR)
    expect(at(restored, BP).dependsOn).toEqual([MAIN])

    // 中断态可重试：retry → pending → 依赖 main 仍 success → 立即可派发（新 requestId）
    let next = reduceStages(restored, { type: 'retry', stageId: BP })
    expect(at(next, BP).status).toBe('pending')
    expect(schedulableStages(next, 0, 4).map((s) => s.id)).toEqual([BP])
    next = reduceStages(next, { type: 'dispatch', stageId: BP, requestId: 'req-bp-fresh' })
    expect(at(next, BP).requestId).toBe('req-bp-fresh')
    expect('req-bp-fresh').not.toBe('req-bp-1')
  })

  it('③ 失败后重试：跨持久化边界新 requestId 不复用', () => {
    let stages = reduceStages(serialTree(), { type: 'dispatch', stageId: MAIN, requestId: 'req-fail-1' })
    stages = reduceStages(stages, { type: 'fail', stageId: MAIN, error: '上游 500' })
    const meta = metaOfStageTask(stages)
    expect(meta?.status).toBe('error')
    // blueprint 被 fail 级联为 skipped——终态，随账本保留
    expect(meta?.stages?.find((s) => s.kind === 'blueprint')?.status).toBe('skipped')
    saveTaskMetas([meta as PersistedTaskMeta])

    const restored = restoreFrom(loadTaskMetas()[0])
    expect(at(restored, MAIN).status).toBe('error')
    expect(at(restored, MAIN).requestId).toBe('req-fail-1')

    // 重试：retryCount 递增 + 旧 requestId 清空；再派发只可能是新 id
    let next = reduceStages(restored, { type: 'retry', stageId: MAIN })
    expect(at(next, MAIN).retryCount).toBe(1)
    expect(at(next, MAIN).requestId).toBeUndefined()
    // skipped blueprint 随 main retry 级联复活（换代失效）
    expect(at(next, BP).status).toBe('pending')
    next = reduceStages(next, { type: 'dispatch', stageId: MAIN, requestId: 'req-fail-2' })
    expect(at(next, MAIN).requestId).toBe('req-fail-2')
    expect('req-fail-2').not.toBe('req-fail-1')
  })

  it('④ 保存/恢复边界：requestId/assetId/参数快照在配额降级（剥 debug）后保全', () => {
    const stages = dispatchAndSucceed(serialTree(), MAIN, 'req-main-1', { assetId: 'ast-main' })
    const meta = {
      ...(metaOfStageTask(stages) as PersistedTaskMeta),
      debug: { endpoint: 'https://x/v1/images/edits', requestBody: { model: 'gpt-image-2.5' }, responseBodyText: 'y'.repeat(900) },
    }
    // 模拟 L1 全量写入配额失败 → L2 剥 debug 重试成功
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === TASKS_KEY && value.includes('"debug"')) throw new DOMException('mock quota exceeded', 'QuotaExceededError')
      originalSetItem.call(this, key, value)
    })
    const outcome = saveTaskMetas([meta])
    expect(outcome.level).toBe('no-payload')

    const [loaded] = loadTaskMetas()
    expect(loaded.debug).toBeUndefined()
    // 终态 stage 快照 + 参数快照 + materialAssetIds 全部保全
    expect(loaded.stages?.[0].requestId).toBe('req-main-1')
    expect(loaded.stages?.[0].assetId).toBe('ast-main')
    expect(loaded.drillParams?.specs).toHaveLength(2)
    expect(loaded.drillParams?.physical).toEqual({ widthMm: 210, heightMm: 148, anchorSource: 'declared' })
    expect(loaded.drillParams?.materialAssetIds).toEqual(['ast-9'])
    expect(loaded.blueprint).toEqual(blueprintSnapshot)
  })
})

describe('账本防御归一：坏结构丢字段不丢任务', () => {
  it('stages 数组内非法条目被剥除，合法条目保留', () => {
    // raw 载荷类型 unknown[]：模拟 localStorage 脏数据（绕过声明类型的窄化）
    const task = makeMeta({ status: 'success' })
    const raw: unknown[] = [
      {
        ...task,
        stages: [
          { id: MAIN, kind: 'main', status: 'success', dependsOn: [], imageStored: true, requestId: 'r1', assetId: 'ast-1', retryCount: 0 },
          { id: 'bad-1', kind: 'nope', status: 'success', dependsOn: [], imageStored: false, retryCount: 0 },
          null,
        ],
      },
    ]
    localStorage.setItem(TASKS_KEY, JSON.stringify(raw))
    const [loaded] = loadTaskMetas()
    expect(loaded.stages).toHaveLength(1)
    expect(loaded.stages?.[0].id).toBe(MAIN)
  })

  it('drillParams.specs 含非法条目 → 整体丢弃；blueprint.strategy 非法 → 整体丢弃', () => {
    const task = makeMeta({ status: 'success' })
    const raw: unknown[] = [
      {
        ...task,
        drillParams: {
          specs: [
            { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
            { junk: true },
          ],
        },
        blueprint: { strategy: 'nonsense', refs: [] },
      },
    ]
    localStorage.setItem(TASKS_KEY, JSON.stringify(raw))
    const [loaded] = loadTaskMetas()
    expect(loaded.drillParams).toBeUndefined()
    expect(loaded.blueprint).toBeUndefined()
  })
})
