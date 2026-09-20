/**
 * 生图生命周期 stage 状态机（纯函数层，UI 无关）。
 *
 * 规范来源：openspec add-lab-drill-params-and-blueprint design §1.2（任务侧高级选项快照）+
 * §1.3（gemgen v2 消费口径——provenance.blueprint 快照/blueprintPrompt 全文快照落键）+
 * §3.1（stage 树模型）+ §3.2（状态机签名冻结）+ §3.3（父任务派生表 / 刷新持久化策略七条 /
 * 归档时点自动双档）+ §3.4（调度与操作粒度）+ §5.1（两档并存与部分失败语义）。
 * 本 change 轨 B（2.1-2.3）唯一实现点；0.3 契约登记在此核对补缺（不重写）；
 * 4.x 接线轨（lab store stage 化）消费本模块，不在 store 内重写状态机。
 *
 * 纪律（本模块级冻结）：
 * 1. 纯函数：不 import Svelte、不触 DOM、不做 IO。时间戳取 Date.now()（非 IO；确定性
 *    测试用 fake timers——事件形状按 design §3.2 冻结，不携带时间戳载荷）。
 * 2. 类型引用只走 `import type`（编译期擦除）：$lib/engine 的 GemSpecSnapshot/PhysicalCanvas
 *    （gem-catalog W0 冻结的 canonical 唯一定义点）、$lib/api/client 的 ImageTaskDebug。
 *    assetId 用裸 string（AssetNodeId 即 string 别名，零摩擦；不引入 assetStore 运行时边）。
 * 3. TaskStatus 与 lab.svelte.ts:97 的同名联合结构恒等（4.x 接线轨统一消费侧）。
 */

import type { ImageTaskDebug } from '$lib/api/client'
import type { GemSpecSnapshot, PhysicalCanvas } from '$lib/engine'

// ---------------------------------------------------------------------------
// 类型（design §3.1 / §1.2 逐字段冻结）
// ---------------------------------------------------------------------------

export type StageKind = 'main' | 'blueprint'

export type StageStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped'

/** 父任务派生状态（≡ lab.svelte.ts TaskStatus 联合；派生不落独立真源——§3.3）。 */
export type TaskStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'

export interface LabStage {
  /** `stage-${taskId}-main` | `stage-${taskId}-blueprint`（stageIdOf 生成）。 */
  id: string
  kind: StageKind
  status: StageStatus
  /** 依赖的前序 stage id（blueprint 串行策略 = [main]；并行策略/无依赖 = []）。 */
  dependsOn: string[]
  /** 请求追踪 id：每次派发新造（crypto.randomUUID 由接线层生成）；重试 = 新 requestId（§3.3 策略 1）。 */
  requestId?: string
  /** 归档产物节点 id（main→gemgen 节点；blueprint→同节点 blueprint 键）。 */
  assetId?: string
  /** 会话展示 URL（objectURL 瞬态，不持久化）。 */
  imageUrl?: string
  imageStored: boolean
  error?: string
  debug?: ImageTaskDebug
  retryCount: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

/** 任务侧水钻参数快照（design §1.2：run 时物化，drillParams.enabled=true 时存在）。 */
export interface LabTaskDrillParams {
  /** specKey → 目录解析物化；ordinal=1..n 按模板数组序。 */
  specs: GemSpecSnapshot[]
  physical?: PhysicalCanvas
  /** 素材附图清单：自定义规格的 .gemshape 贴图 assetId（去重，软上限 4 归轨 A 判定）。 */
  materialAssetIds: string[]
}

/** 任务侧蓝图快照（design §1.2：blueprint.enabled=true 时存在；策略为任务级）。 */
export interface LabTaskBlueprint {
  strategy: 'serial' | 'parallel'
  /** 蓝图参考图 assetId 快照（≤2）。 */
  refs: string[]
}

// ---------------------------------------------------------------------------
// 工厂与查找（4.x 接线消费）
// ---------------------------------------------------------------------------

/** stage id 生成（design §3.1 冻结格式）。 */
export function stageIdOf(taskId: string, kind: StageKind): string {
  return `stage-${taskId}-${kind}`
}

/**
 * 任务初始 stage 树：恒恰一个 kind='main'（pending，无依赖）；blueprint 仅在启用时存在
 * （串行策略 B 依赖 main，并行策略 A 无依赖——design §4.1/§4.2）。
 */
export function createTaskStages(taskId: string, blueprint?: { strategy: 'serial' | 'parallel' }): LabStage[] {
  const main: LabStage = {
    id: stageIdOf(taskId, 'main'),
    kind: 'main',
    status: 'pending',
    dependsOn: [],
    imageStored: false,
    retryCount: 0,
  }
  if (blueprint === undefined) return [main]
  return [
    main,
    {
      id: stageIdOf(taskId, 'blueprint'),
      kind: 'blueprint',
      status: 'pending',
      dependsOn: blueprint.strategy === 'serial' ? [main.id] : [],
      imageStored: false,
      retryCount: 0,
    },
  ]
}

export function findStage(stages: LabStage[], stageId: string): LabStage | undefined {
  return stages.find((s) => s.id === stageId)
}

/** main stage（恒恰一个；畸形树返回 undefined，调用方按防御处理）。 */
export function mainStageOf(stages: LabStage[]): LabStage | undefined {
  return stages.find((s) => s.kind === 'main')
}

/**
 * 产物字段补丁（assetId/imageUrl/imageStored/debug）：接线层在 succeed 事件前后落产物用。
 * 仅限产物/瞬态字段——状态迁移一律走 reduceStages 事件（状态机单一真源纪律）。
 */
export function patchStage(stages: LabStage[], stageId: string, patch: Partial<Pick<LabStage, 'assetId' | 'imageUrl' | 'imageStored' | 'debug'>>): LabStage[] {
  let changed = false
  const next = stages.map((s) => {
    if (s.id !== stageId) return s
    changed = true
    return { ...s, ...patch }
  })
  return changed ? next : stages
}

// ---------------------------------------------------------------------------
// 状态机（design §3.2 签名冻结）
// ---------------------------------------------------------------------------

export type StageEvent =
  | { type: 'dispatch'; stageId: string; requestId: string }
  | { type: 'succeed'; stageId: string }
  | { type: 'fail'; stageId: string; error: string }
  | { type: 'cancel'; stageId: string }
  | { type: 'retry'; stageId: string }
  | { type: 'invalidate'; stageId: string }

/** 终态集合（pending/running 为活动态——账本 terminal-only 纪律的判定基）。 */
export const TERMINAL_STAGE_STATUSES: readonly StageStatus[] = ['success', 'error', 'cancelled', 'skipped']

export function isTerminalStage(status: StageStatus): boolean {
  return status !== 'pending' && status !== 'running'
}

/** stage → pending 的重置形态（清产物/瞬态/时间戳；retryCount 由调用语义决定是否递增）。 */
function resetToPending(stage: LabStage): LabStage {
  return {
    ...stage,
    status: 'pending',
    requestId: undefined,
    assetId: undefined,
    imageUrl: undefined,
    imageStored: false,
    error: undefined,
    debug: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    durationMs: undefined,
  }
}

/** 传递下游闭包：直接/间接 dependsOn 含 rootId 的 stage 下标集。 */
function downstreamIndexes(stages: LabStage[], rootId: string): Set<number> {
  const out = new Set<number>()
  let grew = true
  while (grew) {
    grew = false
    stages.forEach((stage, index) => {
      if (out.has(index)) return
      if (stage.dependsOn.some((dep) => dep === rootId)) {
        out.add(index)
        grew = true
      } else if (stage.dependsOn.some((dep) => stages.some((s, i) => s.id === dep && out.has(i)))) {
        out.add(index)
        grew = true
      }
    })
  }
  return out
}

/**
 * 事件驱动的纯 reduce（design §3.2）。语义要点（§3.3/§3.4）：
 * - dispatch：pending → running，落 requestId/startedAt（由接线层的并发预算与 schedulable 判定把关）。
 * - succeed：running → success（产物字段由接线层经 patchStage 先落，reduce 只迁状态）。
 * - fail：running → error；**下游 pending → skipped**（依赖失败后的不下发）。
 * - cancel：pending|running → cancelled；**下游 pending → cancelled**（取消级联）。
 * - retry：error|cancelled → pending（retryCount+1、旧 requestId 清空——新派发新 requestId）；
 *   **下游非 pending/running 终态一并重置 pending**（成品图换代失配——依赖失效级联）。
 * - invalidate：本 stage 及下游（running 除外）→ pending（依赖产物已换代；retryCount 不动）。
 * 非法迁移（如对终态 succeed、对 success retry）与未知 stageId：原引用返回（幂等 no-op）。
 */
export function reduceStages(stages: LabStage[], event: StageEvent): LabStage[] {
  const index = stages.findIndex((s) => s.id === event.stageId)
  if (index < 0) return stages
  const target = stages[index]

  switch (event.type) {
    case 'dispatch': {
      if (target.status !== 'pending') return stages
      return stages.map((s, i) =>
        i === index
          ? { ...s, status: 'running' as const, requestId: event.requestId, startedAt: Date.now(), error: undefined }
          : s,
      )
    }
    case 'succeed': {
      if (target.status !== 'running') return stages
      const now = Date.now()
      return stages.map((s, i) => {
        if (i !== index) return s
        const startedAt = s.startedAt ?? now
        return { ...s, status: 'success' as const, error: undefined, startedAt, finishedAt: now, durationMs: now - startedAt }
      })
    }
    case 'fail': {
      if (target.status !== 'running') return stages
      const now = Date.now()
      const cascade = downstreamIndexes(stages, target.id)
      return stages.map((s, i) => {
        if (i === index) {
          const startedAt = s.startedAt ?? now
          return { ...s, status: 'error' as const, error: event.error, startedAt, finishedAt: now, durationMs: now - startedAt }
        }
        // 下游 pending → skipped（依赖失败后的不下发；running 下游是畸形树，由接线层 abort 归位）
        if (cascade.has(i) && s.status === 'pending') {
          return { ...s, status: 'skipped' as const, error: undefined }
        }
        return s
      })
    }
    case 'cancel': {
      if (target.status !== 'pending' && target.status !== 'running') return stages
      const now = Date.now()
      const cascade = downstreamIndexes(stages, target.id)
      return stages.map((s, i) => {
        if (i === index) {
          const startedAt = s.startedAt
          return {
            ...s,
            status: 'cancelled' as const,
            error: '已取消',
            finishedAt: now,
            durationMs: startedAt !== undefined ? now - startedAt : undefined,
          }
        }
        if (cascade.has(i) && s.status === 'pending') {
          return { ...s, status: 'cancelled' as const, error: '已取消' }
        }
        return s
      })
    }
    case 'retry': {
      if (target.status !== 'error' && target.status !== 'cancelled') return stages
      const cascade = downstreamIndexes(stages, target.id)
      return stages.map((s, i) => {
        if (i === index) return { ...resetToPending(s), retryCount: s.retryCount + 1 }
        // 下游残留终态（skipped/cancelled/error/success）基于旧产物——换代失效，一并重置；
        // pending 原样（本就待派发），running 是畸形树不动（接线层 abort 归位）。
        if (cascade.has(i) && s.status !== 'pending' && s.status !== 'running') {
          return resetToPending(s)
        }
        return s
      })
    }
    case 'invalidate': {
      // running 必须先由接线层 abort（cancel 事件归位）；此处只重置非 running 的换代失效面。
      const cascade = downstreamIndexes(stages, target.id)
      let changed = false
      const next = stages.map((s, i) => {
        const inScope = i === index || cascade.has(i)
        if (!inScope || s.status === 'running' || s.status === 'pending') return s
        changed = true
        return resetToPending(s)
      })
      return changed ? next : stages
    }
  }
}

// ---------------------------------------------------------------------------
// 父任务派生（design §3.3 派生表逐行）
// ---------------------------------------------------------------------------

/**
 * 父任务状态派生（不落独立真源）：
 * - main pending/running → pending/running（blueprint 任意态不抬升）。
 * - main success，无 blueprint stage → success。
 * - main success + blueprint pending/running → running（蓝图进行中）。
 * - main success + blueprint success/error/cancelled/skipped → success（徽标/单独重试走 stage 面）。
 * - main error → error（blueprint 已被 fail 级联为 skipped）。
 * - main cancelled → cancelled。
 * - main skipped（畸形防御）→ cancelled（skipped 档案投影压缩规则，§3.3 策略 5）。
 */
export function deriveTaskStatus(stages: LabStage[]): TaskStatus {
  const main = mainStageOf(stages)
  if (main === undefined) return 'pending'
  switch (main.status) {
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    case 'cancelled':
    case 'skipped':
      return 'cancelled'
    case 'success': {
      const blueprint = stages.find((s) => s.kind === 'blueprint')
      if (blueprint === undefined) return 'success'
      return blueprint.status === 'pending' || blueprint.status === 'running' ? 'running' : 'success'
    }
  }
}

/**
 * 蓝图徽标派生（§3.3 派生表会话徽标列 + §3.3 策略 3「蓝图已中断，可重试」恢复态）。
 * 无 blueprint stage（未启用/legacy）→ null。
 */
export type BlueprintTaskBadge = 'in-progress' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'interrupted'

/** 刷新中断标记（stagesFromPersisted 合成「已中断可重试」态时落的 error 文案——typed 判别用）。 */
export const BLUEPRINT_INTERRUPTED_ERROR = '蓝图已中断（页面刷新），可重试'

export function deriveBlueprintBadge(stages: LabStage[]): BlueprintTaskBadge | null {
  const blueprint = stages.find((s) => s.kind === 'blueprint')
  if (blueprint === undefined) return null
  if (blueprint.status === 'cancelled' && blueprint.error === BLUEPRINT_INTERRUPTED_ERROR) return 'interrupted'
  switch (blueprint.status) {
    case 'pending':
    case 'running':
      return 'in-progress'
    case 'success':
      return 'success'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
  }
}

// ---------------------------------------------------------------------------
// 调度（design §3.4：并发预算按 stage = 请求数；MAX_CONCURRENCY 常量归 lab store，此处参数化）
// ---------------------------------------------------------------------------

/**
 * 可派发 stage：依赖满足（dependsOn 全 success；缺失依赖视为不满足）且 pending 的
 * 前 max-runningCount 个（数组序）。并发预算由接线层以 running stage 计数喂入
 * （= 请求数——MAX_CONCURRENCY=4 语义细化，数值不变）。
 */
export function schedulableStages(stages: LabStage[], runningCount: number, max: number): LabStage[] {
  const slots = max - runningCount
  if (slots <= 0) return []
  const statusById = new Map(stages.map((s) => [s.id, s.status] as const))
  const out: LabStage[] = []
  for (const stage of stages) {
    if (out.length >= slots) break
    if (stage.status !== 'pending') continue
    if (!stage.dependsOn.every((dep) => statusById.get(dep) === 'success')) continue
    out.push(stage)
  }
  return out
}

// ---------------------------------------------------------------------------
// 持久化投影（design §3.3 刷新持久化策略七条；2.3）
// ---------------------------------------------------------------------------

/** 账本侧父任务终态（≡ taskStore.PersistedTaskStatus 联合；本模块不反向依赖 taskStore）。 */
export type TerminalTaskStatus = 'success' | 'error' | 'cancelled'

/** 终态 stage 专属状态（活动态 pending/running 不落账本——策略 1）。 */
export type PersistedStageStatus = 'success' | 'error' | 'cancelled' | 'skipped'

/**
 * 账本 stage 快照（terminal-only）：只承状态机持久字段——imageUrl（objectURL 瞬态）与
 * debug（大字段）永不落账本（策略 4「活动 stage 零持久化」的投影半边；debug 剥离属
 * taskStore 配额降级域，stage 投影天然不含）。
 */
export interface PersistedStageMeta {
  id: string
  kind: StageKind
  status: PersistedStageStatus
  dependsOn: string[]
  requestId?: string
  assetId?: string
  imageStored: boolean
  error?: string
  retryCount: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

/** 终态投影：只保留 terminal stage（活动 stage 刷新即丢——策略 1）。键序=声明序（序列化确定性）。 */
export function stagesToPersisted(stages: LabStage[]): PersistedStageMeta[] {
  return stages
    .filter((s) => isTerminalStage(s.status))
    .map((s): PersistedStageMeta => ({
      id: s.id,
      kind: s.kind,
      status: s.status as PersistedStageStatus,
      dependsOn: [...s.dependsOn],
      ...(s.requestId !== undefined ? { requestId: s.requestId } : {}),
      ...(s.assetId !== undefined ? { assetId: s.assetId } : {}),
      imageStored: s.imageStored,
      ...(s.error !== undefined ? { error: s.error } : {}),
      retryCount: s.retryCount,
      ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
    }))
}

/**
 * 落账本资格与账本侧父状态：main 活动态 → null（整任务不落账本——main 不可合成恢复）；
 * main 终态 → 刷新后视角的父状态（success/error/cancelled；活动 blueprint 刷新即丢，
 * 故 main success 恒映 'success'，与 stagesToPersisted 投影后 deriveTaskStatus 等价）。
 */
export function persistedTaskStatusOf(stages: LabStage[]): TerminalTaskStatus | null {
  const main = mainStageOf(stages)
  if (main === undefined || !isTerminalStage(main.status)) return null
  switch (main.status) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    // cancelled + skipped（畸形防御）投影为 cancelled（§3.3 策略 5）
    default:
      return 'cancelled'
  }
}

/** stagesFromPersisted 输入（PersistedTaskMeta 的 stage 相关子集 + 蓝图快照存在性）。 */
export interface RestoredStageInput {
  /** 顶层终态（legacy 账本无 stages 时合成 main stage 的数据源）。 */
  status: TerminalTaskStatus
  assetId?: string
  error?: string
  imageStored?: boolean
  finishedAt?: number
  durationMs?: number
  /** 终态 stage 快照（新账本）；缺席/空 → legacy 合成。 */
  stages?: PersistedStageMeta[]
  /** 蓝图快照存在（task.blueprint）而 stages 无终态 blueprint → 合成「已中断，可重试」。 */
  hasBlueprint?: boolean
  /** 蓝图策略（合成中断态的 dependsOn：serial→[main]，parallel→[]；缺省按 serial）。 */
  blueprintStrategy?: 'serial' | 'parallel'
}

/** 账本恢复（读时合成，不回写——策略 7 同族纪律）：legacy 合成 + 中断蓝图合成。 */
export function stagesFromPersisted(taskId: string, input: RestoredStageInput): LabStage[] {
  const persisted = input.stages ?? []
  const mainMeta = persisted.find((s) => s.kind === 'main')

  const main: LabStage =
    mainMeta !== undefined
      ? { ...mainMeta, dependsOn: [...mainMeta.dependsOn] }
      : {
          // legacy 账本（无 stages）：顶层终态字段合成只读 main stage（策略 7）
          id: stageIdOf(taskId, 'main'),
          kind: 'main',
          status: input.status,
          dependsOn: [],
          ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
          imageStored: input.imageStored ?? input.assetId !== undefined,
          ...(input.error !== undefined ? { error: input.error } : {}),
          retryCount: 0,
          ...(input.finishedAt !== undefined && input.durationMs !== undefined
            ? { startedAt: input.finishedAt - input.durationMs }
            : {}),
          ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        }

  const blueprintMeta = persisted.find((s) => s.kind === 'blueprint')
  const blueprint: LabStage | undefined =
    blueprintMeta !== undefined
      ? { ...blueprintMeta, dependsOn: [...blueprintMeta.dependsOn] }
      : input.hasBlueprint === true
        ? {
            // 蓝图启用但无终态快照 = 刷新时正在跑（活动 stage 中断丢弃）——合成可重试中断态（策略 3）
            id: stageIdOf(taskId, 'blueprint'),
            kind: 'blueprint',
            status: 'cancelled',
            dependsOn: input.blueprintStrategy === 'parallel' ? [] : [main.id],
            error: BLUEPRINT_INTERRUPTED_ERROR,
            imageStored: false,
            retryCount: 0,
            ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
          }
        : undefined

  return blueprint !== undefined ? [main, blueprint] : [main]
}

// ---------------------------------------------------------------------------
// 账本字段的防御归一（taskStore.restoreTask 消费；坏结构丢字段不丢任务）
// ---------------------------------------------------------------------------

function isPersistedStageStatus(value: unknown): value is PersistedStageStatus {
  return value === 'success' || value === 'error' || value === 'cancelled' || value === 'skipped'
}

/** 非法条目整条丢弃（id/kind/status 必须合法；dependsOn 剥非字符串项）。 */
export function normalizePersistedStages(value: unknown): PersistedStageMeta[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PersistedStageMeta[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const v = entry as Record<string, unknown>
    if (typeof v.id !== 'string' || !v.id) continue
    if (v.kind !== 'main' && v.kind !== 'blueprint') continue
    if (!isPersistedStageStatus(v.status)) continue
    if (!Array.isArray(v.dependsOn)) continue
    out.push({
      id: v.id,
      kind: v.kind,
      status: v.status,
      dependsOn: v.dependsOn.filter((d): d is string => typeof d === 'string' && d.length > 0),
      ...(typeof v.requestId === 'string' && v.requestId ? { requestId: v.requestId } : {}),
      ...(typeof v.assetId === 'string' && v.assetId ? { assetId: v.assetId } : {}),
      imageStored: v.imageStored === true,
      ...(typeof v.error === 'string' && v.error ? { error: v.error } : {}),
      retryCount: typeof v.retryCount === 'number' && Number.isFinite(v.retryCount) && v.retryCount >= 0 ? v.retryCount : 0,
      ...(typeof v.startedAt === 'number' && Number.isFinite(v.startedAt) ? { startedAt: v.startedAt } : {}),
      ...(typeof v.finishedAt === 'number' && Number.isFinite(v.finishedAt) ? { finishedAt: v.finishedAt } : {}),
      ...(typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) ? { durationMs: v.durationMs } : {}),
    })
  }
  return out
}

/** 镜像 engine.SHAPE_IDS（W0 冻结枚举；本模块不引 engine 运行时，validator 本地字面校验）。 */
const SPEC_SHAPE_IDS: readonly string[] = ['round', 'square', 'drop', 'heart', 'marquise', 'custom']

function normalizeGemSpecSnapshot(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.specKey === 'string' &&
    v.specKey.length > 0 &&
    typeof v.ordinal === 'number' &&
    Number.isInteger(v.ordinal) &&
    v.ordinal >= 1 &&
    typeof v.shapeId === 'string' &&
    SPEC_SHAPE_IDS.includes(v.shapeId) &&
    typeof v.sizeLabel === 'string' &&
    v.sizeLabel.length > 0 &&
    typeof v.diameterMm === 'number' &&
    Number.isFinite(v.diameterMm) &&
    v.diameterMm > 0 &&
    // [R5-P1 统一契约] 反向强制（镜像 W0 GemSpecSnapshotSchema）：custom 必带 assetId——
    // 脏账本（缺资产引用的 custom 快照）整份 drillParams 拒读，不恢复无法解析素材的规格。
    (v.shapeId !== 'custom' || (typeof v.assetId === 'string' && v.assetId.length > 0))
  )
}

/**
 * 任务侧水钻参数快照归一：specs 任一条目非法 → 整体丢弃（部分清单会让 ordinal 说谎）；
 * physical 非法 → 视为缺席（可选元数据）；materialAssetIds 非法 → 空数组。
 * [R6 P2-1] materialAssetIds 恢复去重（Set 首见序）——脏账本重复 id 不重复附图/不计双份配额。
 */
export function normalizeLabTaskDrillParams(value: unknown): LabTaskDrillParams | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  // §1.3 单一真源纪律：drillParams 存在 ≡ specs 非空
  if (!Array.isArray(v.specs) || v.specs.length === 0) return undefined
  if (!v.specs.every((spec) => normalizeGemSpecSnapshot(spec))) return undefined
  const specs = v.specs as GemSpecSnapshot[]
  let physical: PhysicalCanvas | undefined
  if (v.physical !== null && typeof v.physical === 'object') {
    const p = v.physical as Record<string, unknown>
    if (
      typeof p.widthMm === 'number' &&
      p.widthMm > 0 &&
      typeof p.heightMm === 'number' &&
      p.heightMm > 0 &&
      (p.anchorSource === 'declared' || p.anchorSource === 'default')
    ) {
      physical = { widthMm: p.widthMm, heightMm: p.heightMm, anchorSource: p.anchorSource }
    }
  }
  const materialAssetIds = Array.isArray(v.materialAssetIds)
    ? [...new Set(v.materialAssetIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  return { specs, ...(physical !== undefined ? { physical } : {}), materialAssetIds }
}

/** 任务侧蓝图快照归一：strategy 非法 → 整体丢弃；refs 剥非字符串项。 */
export function normalizeLabTaskBlueprint(value: unknown): LabTaskBlueprint | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (v.strategy !== 'serial' && v.strategy !== 'parallel') return undefined
  const refs = Array.isArray(v.refs) ? v.refs.filter((r): r is string => typeof r === 'string' && r.length > 0) : []
  return { strategy: v.strategy, refs }
}

// ---------------------------------------------------------------------------
// 归档契约（0.3 补缺：design §3.3 派生表归档列 + §5.1 自动双档 + §1.3 gemgen v2 消费口径）
// ---------------------------------------------------------------------------

/**
 * gemgen provenance.blueprint 快照（design §1.3——档案侧蓝图请求正交快照；
 * 4.1 labFile 键位接线消费本口径，provenance 级 ≠ blueprint 图键（成功产物））。
 */
export interface ProvenanceBlueprintSnapshot {
  strategy: 'serial' | 'parallel'
  status: 'success' | 'failed' | 'cancelled'
  error?: string
}

/** skipped 档案投影错误码（§3.3 策略 5：内部独立终态 → 档案投影压缩 cancelled + 错误码）。 */
export const SKIPPED_UPSTREAM_ERROR_CODE = 'SKIPPED_UPSTREAM'

/**
 * 蓝图请求全文快照落 provenance 的键名（§5.2 冻结：**落 provenance.blueprintPrompt**，
 * blueprint 键只承图与溯源 id——图与文分离沿 image 键先例；4.1 labFile 接线消费）。
 */
export const PROVENANCE_BLUEPRINT_PROMPT_KEY = 'blueprintPrompt'

/**
 * 蓝图 stage 终态 → provenance.blueprint 快照投影（§3.3 派生表 + 策略 5）：
 * - success → { status: 'success' }
 * - error → { status: 'failed', error 透传 }
 * - cancelled → { status: 'cancelled', error 透传（「已取消」/中断文案）}
 * - skipped → { status: 'cancelled', error: SKIPPED_UPSTREAM_ERROR_CODE }（有意压缩映射）
 * 仅对终态 stage 有意义；活动态输入防御性投影 cancelled（调用面为 deriveArchivePlan，不应发生）。
 */
export function blueprintProvenanceOf(
  strategy: 'serial' | 'parallel',
  stage: Pick<LabStage, 'status' | 'error'>,
): ProvenanceBlueprintSnapshot {
  switch (stage.status) {
    case 'success':
      return { strategy, status: 'success' }
    case 'error':
      return { strategy, status: 'failed', ...(stage.error !== undefined ? { error: stage.error } : {}) }
    case 'skipped':
      return { strategy, status: 'cancelled', error: SKIPPED_UPSTREAM_ERROR_CODE }
    case 'cancelled':
      return { strategy, status: 'cancelled', ...(stage.error !== undefined ? { error: stage.error } : {}) }
    default:
      // pending/running（活动态）——防御性投影；账本 terminal-only 下不会走到该分支
      return { strategy, status: 'cancelled' }
  }
}

/** 归档单元：single = 单图先行档（无 blueprint 键）；full = 双图完整档（blueprint 终态）。 */
export type ArchiveUnit =
  | { kind: 'single' }
  | { kind: 'full'; blueprint: ProvenanceBlueprintSnapshot }

/**
 * 归档时点决策（§3.3 派生表归档列 + §5.1 自动触发——**stage 终态即档，不等用户动作**）：
 * - main 活动态 / error / cancelled / skipped（畸形） → []（不归档）。
 * - main success → 恒含「单图先行档」（blueprint 未终态即此刻定稿——blob URL 会话即逝，
 *   先档防刷新丢字节）；blueprint stage 存在且终态 → 追加「双图完整档」（成功含图；
 *   error/cancelled/skipped 落 provenance 态无图）。
 * - **两档并存**：返回按 [先行单图档, 双图完整档] 声明序；本函数无状态，**幂等判重按两档
 *   分别进行**（§3.3 策略 6——已档单元由 4.4 reconcileUnarchivedResults 判重跳过）。
 */
export function deriveArchivePlan(
  stages: LabStage[],
  blueprintStrategy: 'serial' | 'parallel' = 'serial',
): ArchiveUnit[] {
  const main = mainStageOf(stages)
  if (main === undefined || main.status !== 'success') return []
  const blueprint = stages.find((s) => s.kind === 'blueprint')
  if (blueprint === undefined) return [{ kind: 'single' }]
  if (!isTerminalStage(blueprint.status)) return [{ kind: 'single' }]
  return [{ kind: 'single' }, { kind: 'full', blueprint: blueprintProvenanceOf(blueprintStrategy, blueprint) }]
}
