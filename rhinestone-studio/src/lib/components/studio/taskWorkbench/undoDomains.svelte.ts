/*
 * undoDomains.svelte.ts——undo 四域状态机（add-workbench-pro 2c；design 附录 D-3
 * 冻结语义的客户端游标面）。
 *
 * Orthogonal intents (max 3):
 * 1. [域划分] 四域独立游标：tree-structure（拆层/改名/重排/删除/回退——tree_versions
 *    链，回退经 tree.revert）/ tree-view（显隐/折叠/锁定——视图态快照栈，回退=上一版
 *    快照经 view.state.set 整体回放）/ mask-edit（笔刷本地笔画栈——提交前逐笔撤销）
 *    / strategy-param（策略直改——上一版指派参数重放）。每域独立；本域栈空提示而不
 *    自动跨域。
 * 2. [焦点路由] Ctrl+Z 路由优先级：画布 mask 编辑态（笔刷激活）→ mask-edit ＞
 *    最近一次操作的域（显隐/折叠/锁定操作后→tree-view——PS「上一步」直觉；焦点
 *    显式切换即清除重定向）＞ 焦点域（图层树→tree-structure；策略卡→
 *    strategy-param）。域操作与焦点变化均推动该状态（D-3「当前焦点域」共同不变量）。
 * 3. [栈语义] 快照栈=「截断式游标」：新操作在游标后截断再入栈（标准 undo 栈）；
 *    服务端版本链只增不删（tree_versions/tree.history 面如实全量）。结构域版本
 *    游标在 undo 后以 revert 落定的新版本号顶替原位（同树态新版本 id）。
 */

import type { KernelStrategyKind, TreeVersion, ViewStateNode } from '@handicraft/contracts'

export type UndoDomain = 'tree-structure' | 'tree-view' | 'mask-edit' | 'strategy-param'

export const UNDO_DOMAIN_LABELS: Record<UndoDomain, string> = {
  'tree-structure': '图层结构',
  'tree-view': '视图态',
  'mask-edit': '遮罩编辑',
  'strategy-param': '策略参数',
}

/** 策略域快照（applyLayerStrategy 前值——重放经 layer.strategy.set）。 */
export interface ParamUndoSnapshot {
  nodeId: string
  /** 前值（null=此前未指派——首指派无「取消指派」RPC，回退面如实受限）。 */
  strategyKind: KernelStrategyKind | null
  params: Record<string, unknown>
  densityPerCm2: number
}

/** 焦点域（UI focusin/交互上下文推动：图层树→structure；策略卡→param）。 */
let focusDomain = $state<UndoDomain>('tree-structure')
/** 最近一次操作的域（null=会话起无操作——路由退回焦点域）。 */
let lastActionDomain = $state<UndoDomain | null>(null)

// ---- tree-view 域：视图态「操作前快照」栈（undo=弹出最近一条整体回放；redo 2d） ----
let viewStack = $state<ViewStateNode[][]>([])

// ---- mask-edit 域：本地笔画栈由 store.brush 承载（2b 既有）；此处记录已提交
// 遮罩编辑版本（信息面——已提交遮罩的精确逆属 2d 契约扩展，D-3 实现波注记） ----
let committedMaskVersions = $state<number[]>([])

// ---- strategy-param 域：指派前值栈（截断式游标） ----
let paramStack = $state<ParamUndoSnapshot[]>([])
let paramCursor = $state(-1)

// ---- tree-structure 域：版本号游标（链来自 tree.history+自身写响应） ----
let structureVersions = $state<number[]>([])
let structureCursor = $state(-1)

/**
 * 焦点域推动（UI focusin）：显式切换上下文=清除「最近操作域」重定向——D-3
 * 「跨域=用户显式切换上下文」：显隐开关后 Ctrl+Z 回视图域，焦点再落到策略卡则
 * 尊重新上下文（不粘连旧域）。
 */
export function setUndoFocusDomain(domain: UndoDomain): void {
  focusDomain = domain
  lastActionDomain = null
}

export function getUndoFocusDomain(): UndoDomain {
  return focusDomain
}

/** 域操作发生时推动（路由第二优先级——视图态开关后 Ctrl+Z 即回退视图）。 */
export function noteUndoAction(domain: UndoDomain): void {
  lastActionDomain = domain
}

/**
 * Ctrl+Z 目标域（D-3 共同不变量的路由判定）：笔刷激活恒 mask-edit（画布编辑态）
 * ＞ 最近操作域（有可回退项时）＞ 焦点域。纯读取——不改变状态。
 */
export function resolveUndoDomain(brushActive: boolean): UndoDomain {
  if (brushActive) return 'mask-edit'
  if (lastActionDomain !== null && domainHasUndo(lastActionDomain, brushActive)) return lastActionDomain
  return focusDomain
}

/** 域内是否还有可回退项（路由判定+「本域已无可回退」提示共用）。 */
export function domainHasUndo(domain: UndoDomain, brushActive = false): boolean {
  switch (domain) {
    case 'mask-edit':
      return brushActive // 本地笔画栈在 store.brush——strokes.length 由调用方并入判断
    case 'tree-view':
      return viewStack.length > 0
    case 'strategy-param':
      return paramCursor >= 0
    case 'tree-structure':
      return structureCursor > 0
  }
}

// ---------------------------------------------------------------- tree-view 域

/** 视图态操作前快照入栈（toggleVisible/Collapsed/Locked 各操作调用一次）。 */
export function pushViewUndoSnapshot(snapshot: ViewStateNode[]): void {
  viewStack = [...viewStack, snapshot.map((node) => ({ ...node }))]
}

/** 弹出最近一条操作前快照（整体回放=撤一步；null=已到栈底）。
 *  $state.snapshot 脱离深代理——回放载荷可被服务端 structuredClone（proxy 不可克隆）。 */
export function popViewUndo(): ViewStateNode[] | null {
  if (viewStack.length === 0) return null
  const target = viewStack[viewStack.length - 1]!
  viewStack = viewStack.slice(0, -1)
  return $state.snapshot(target)
}

/** 视图域栈深（信息面/测试）。 */
export function viewUndoDepth(): number {
  return viewStack.length
}

// ---------------------------------------------------------------- mask-edit 域

/** 已提交遮罩编辑版本记录（信息面——精确逆 2d；历史面板聚合呈现用）。 */
export function noteCommittedMaskVersion(version: number): void {
  committedMaskVersions = [...committedMaskVersions, version]
}

export function getCommittedMaskVersions(): number[] {
  return committedMaskVersions
}

// ---------------------------------------------------------------- strategy-param 域

/** 策略直改前值入栈（截断 redo 分支）。 */
export function pushParamUndo(snapshot: ParamUndoSnapshot): void {
  paramStack = [...paramStack.slice(0, paramCursor + 1), snapshot]
  paramCursor = paramStack.length - 1
}

/** 弹出上一版前值（游标回退；null=已到栈底；$state.snapshot 脱离深代理）。 */
export function popParamUndo(): ParamUndoSnapshot | null {
  if (paramCursor < 0) return null
  const target = paramStack[paramCursor] ?? null
  paramCursor -= 1
  return target === null ? null : $state.snapshot(target)
}

export function paramUndoDepth(): number {
  return paramCursor + 1
}

// ---------------------------------------------------------------- tree-structure 域

/** 结构域版本链整链重种（装载/tree.history 面刷新/结构写后重读——游标置尾）。 */
export function reseedStructureVersions(versions: number[]): void {
  structureVersions = [...versions]
  structureCursor = versions.length - 1
}

/**
 * 结构域 undo 目标版本（游标前一格；null=已到链底）。不移动游标——revert 落定后
 * 经 applyStructureUndoResult 收口。
 */
export function structureUndoTarget(): number | null {
  if (structureCursor <= 0) return null
  return structureVersions[structureCursor - 1] ?? null
}

/**
 * 结构域 undo 落定收口：revert 产生新版本号（同树态新 id——顶替原位，游标回退一格）。
 * 新结构写（reorder/delete/rename/split 后 reseed）则整链重种（上方）。
 */
export function applyStructureUndoResult(revertVersion: number): void {
  if (structureCursor <= 0) return
  structureVersions = [
    ...structureVersions.slice(0, structureCursor - 1),
    revertVersion,
    ...structureVersions.slice(structureCursor + 1),
  ]
  structureCursor -= 1
}

/** 结构域链可回退深度（当前游标位——undo 可执行次数）。 */
export function structureUndoDepth(): number {
  return Math.max(0, structureCursor)
}

/** 服务端版本行 → 结构域版本号链（mask-patch 归 mask 域——D-3 域归属过滤）。 */
export function structureVersionsOf(versions: TreeVersion[]): number[] {
  return versions.filter((version) => version.cause !== 'mask-patch').map((version) => version.version)
}

// ---------------------------------------------------------------- 复位

export function resetUndoDomainsForTests(): void {
  focusDomain = 'tree-structure'
  lastActionDomain = null
  viewStack = []
  committedMaskVersions = []
  paramStack = []
  paramCursor = -1
  structureVersions = []
  structureCursor = -1
}
