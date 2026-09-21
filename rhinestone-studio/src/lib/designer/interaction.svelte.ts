/*
 * Orthogonal intents (max 4):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 画布瞬时交互态（拖移预览/
 *    属性面板定位焦点）——独立于 workbench.svelte.ts 态模块（共享文件只加不改的并行纪律下，
 *    本切片新态自成模块；jsdom 无 2d 上下文，测试经本模块读取面断言，浏览器经画布
 *    ghost/读数气泡消费）。
 * 2. [进行中手势取消注册表] Esc/系统打断取消进行中的拖移/变换会话（design §2 通用约束：
 *    进行中手势可 Esc 取消，不产生 undo 组）——会话注册 canceler，键盘 Esc 经
 *    cancelActiveInteraction() 单点裁决（消费返回 true 则不再清空选择）。
 * 3. [rework R4.1 ⌘T 自由变换态真源（design §3.1——单选专用柄退役，交互统一 ⌘T）]
 *    enterTransformMode/exitTransformMode + pending 覆盖累积（多柄连拖合并；Enter 确认 =
 *    commands.confirm-transform 单 patch 单 undo 组，Esc = 取消注册表零 patch 退出——
 *    变换态取消最优先）+ 拖拽实时读数（%/mm/°——designer-transform-readout 气泡消费；
 *    旧 TransformPreview 单柄读数随 P6/P7 退役删除）。
 *    [rework R4.2] 框选实时命中数读数（design §3.2 marquee 角落轻量计数——canvas 拖拽
 *    逐帧写、画布角落绘制、reset 复位）。
 * 4. [Test] resetInteractionForTests 复位（预览/焦点/变换态/框选计数/取消注册全清）。
 */

import type { TransformBounds, TransformPendingFields } from './gestures'

/** P5 拖移预览读数（拖拽中画布 ghost 偏移；copy=true 为 Alt 副本拖移）。 */
export interface MovePreview {
  dx: number
  dy: number
  copy: boolean
}

/** P8 属性面板定位焦点（双击钻 → 视图滚动到字段并高亮；seq 消除同 gem 连击去重）。 */
export interface PropertiesFocus {
  gemId: string
  seq: number
}

/** ⌘T 变换态（进态快照定格——§2 红线：钻位不动 ⇒ 包围盒会话期恒定）。 */
export interface TransformModeState {
  /** 进态选集（doc 快照 id 序；提交时按 id 逐钻解析，缺席跳过）。 */
  gemIds: string[]
  /** 选集包围盒（柄锚点/拖拽决策基准——gestures.selectionBoundsOf 产物）。 */
  bounds: TransformBounds
  /** 非 round-only 选集才可旋转（design §3.1 裁断：round 旋转值恒 0、旋转柄禁用灰显）。 */
  rotationEnabled: boolean
  /** 待提交字段累积（gemId → 直径/角度覆盖；Enter 单 patch 提交，Esc 随态丢弃）。 */
  pending: Record<string, TransformPendingFields>
}

/** 变换拖拽实时读数（scale = %（单选附参考 mm）；rotate = 相对起拖增量°）。 */
export type TransformDragReadout =
  | { kind: 'scale'; percent: number; mm: number | null }
  | { kind: 'rotate'; deltaDeg: number }

let movePreview = $state<MovePreview | null>(null)
let propertiesFocus = $state<PropertiesFocus | null>(null)
let focusSeq = 0

// 进行中手势取消注册表（会话起注册、收笔/取消注销）
let cancelers: Array<() => void> = []

// [R4.1] ⌘T 变换态（模块单真源；canvas/overlay/commands/keymap 共读）
let transformMode = $state<TransformModeState | null>(null)
let transformReadout = $state<TransformDragReadout | null>(null)
let unregisterTransformCancel: (() => void) | null = null

/**
 * [R5.2 走查回修 P1-1] pending 写入的显式失效信号：updateTransformPending 逐帧 bump。
 * 画布重绘 effect 显式读它——不依赖「跨 $derived 传递的 state proxy 属性读被 effect 追踪」
 * 这一隐式行为（走查实证：拖拽读数气泡活、画布零实时预览——渲染循环对 pending 写入
 * 不失效即断链；显式计数位使失效面确定性成立，jsdom 亦可在无 2d 光栅下断言消费链）。
 */
let transformPendingTick = $state(0)

// [R4.2] 框选实时命中数（design §3.2 marquee 角落轻量计数；null = 无进行中框选）
let marqueeHitCount = $state<number | null>(null)

export function getMovePreview(): MovePreview | null {
  return movePreview
}

export function setMovePreview(preview: MovePreview | null): void {
  movePreview = preview === null ? null : { ...preview }
}

export function getPropertiesFocus(): PropertiesFocus | null {
  return propertiesFocus
}

/** P8 焦点写入（同 gem 重复双击递增 seq——消费 effect 按次触发）。 */
export function setPropertiesFocus(gemId: string | null): void {
  propertiesFocus = gemId === null ? null : { gemId, seq: ++focusSeq }
}

export function getTransformMode(): TransformModeState | null {
  return transformMode
}

export function isTransformModeActive(): boolean {
  return transformMode !== null
}

export function getTransformReadout(): TransformDragReadout | null {
  return transformReadout
}

export function setTransformReadout(readout: TransformDragReadout | null): void {
  transformReadout = readout
}

/**
 * 进入变换态（commands.enter-transform 构造入参）：已激活返回 false（⌘T 二按 no-op）；
 * 进态即注册 Esc 取消器——变换态取消在取消链中最优先（design §3.1：Esc = 零 patch 退出）。
 */
export function enterTransformMode(init: {
  gemIds: string[]
  bounds: TransformBounds
  rotationEnabled: boolean
}): boolean {
  if (transformMode !== null) return false
  transformMode = { ...init, pending: {} }
  transformReadout = null
  unregisterTransformCancel = registerGestureCancel(() => exitTransformMode())
  return true
}

/** 退出变换态（Enter 确认在 commands 先取快照再退；Esc/打断零 patch 直退）。 */
export function exitTransformMode(): void {
  transformMode = null
  transformReadout = null
  unregisterTransformCancel?.()
  unregisterTransformCancel = null
}

/** 拖拽逐帧合并待提交字段（多柄连拖累积——per-gem 字段级 merge；每次写入 bump 失效信号）。 */
export function updateTransformPending(updates: Readonly<Record<string, TransformPendingFields>>): void {
  if (transformMode === null) return
  const next: Record<string, TransformPendingFields> = { ...transformMode.pending }
  for (const [id, fields] of Object.entries(updates)) {
    next[id] = { ...next[id], ...fields }
  }
  transformMode.pending = next
  transformPendingTick += 1
}

/** [P1-1 回修] pending 失效信号读取面（画布重绘 effect 显式追踪——见字段注）。 */
export function getTransformPendingTick(): number {
  return transformPendingTick
}

/** [R4.2] 框选实时命中数读取（marquee 角落计数；null = 无进行中框选）。 */
export function getMarqueeHitCount(): number | null {
  return marqueeHitCount
}

/** [R4.2] 框选命中数写入（canvas 拖拽逐帧写；marquee 清场时置 null）。 */
export function setMarqueeHitCount(count: number | null): void {
  marqueeHitCount = count
}

/** 注册进行中手势的取消器；返回注销函数。 */
export function registerGestureCancel(cancel: () => void): () => void {
  cancelers.push(cancel)
  return () => {
    cancelers = cancelers.filter((c) => c !== cancel)
  }
}

/** 是否存在进行中手势（拖移会话/变换态）。 */
export function hasActiveGesture(): boolean {
  return cancelers.length > 0
}

/**
 * 取消所有进行中手势（Esc 单点裁决）：存在被取消的会话返回 true（调用方不再执行
 * Esc 的清空选择语义——取消优先，选择保持）。
 */
export function cancelActiveInteraction(): boolean {
  if (cancelers.length === 0) return false
  const all = [...cancelers]
  cancelers = []
  for (const cancel of all) cancel()
  setMovePreview(null)
  return true
}

/** 测试专用：整体复位（预览/焦点/变换态/框选计数/取消注册全清）。 */
export function resetInteractionForTests(): void {
  movePreview = null
  propertiesFocus = null
  focusSeq = 0
  cancelers = []
  transformMode = null
  transformReadout = null
  transformPendingTick = 0
  unregisterTransformCancel = null
  marqueeHitCount = null
}
