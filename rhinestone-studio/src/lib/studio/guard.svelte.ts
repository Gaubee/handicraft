/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 add-project-files 2.6] 守卫三分法之「页内破坏性动作」支（design §3）：三按钮
 *    「保存并继续 / 不保存 / 取消」共享状态机——触发面（openIntent 打开其它项目 / 缺源重绑 /
 *    换来源图 / 新建会话：送排钻 handoff + 空态选图）一律经 runStudioGuarded 包装；保存复用
 *    ④段 projectPersistence.saveGemproj 链路（首存默认名 = 来源图名去扩展名；CAS 冲突/不可序列化
 *    就地报错不清会话）。其余两支：切 Tab 不弹（store 单例跨视图存活——本模块同单例，无路由
 *    守卫参与；●未保存徽标常驻归 StudioContextBar）；beforeunload 归 StudioView
 *    （svelte:window——本模块不触 DOM）。
 * 2. [挂起意图回执] 守卫期间挂起的 gemproj openIntent claim：取消 → ackFailure
 *    （'gemproj-open-guard-cancelled'，EditView guardClaim 同式）；保存/不保存 → 挂起动作内
 *    自行 ack。onCancel 钩子供非意图触发面的取消清理（送排钻 handoff 取消 = clearHandoff 丢弃交接）。
 */

import { isStudioDirty, saveGemproj } from '$lib/studio/projectPersistence.svelte'
import { ackOpenIntentFailure, type OpenIntentClaim } from '$lib/stores/openIntent.svelte'

export interface StudioGuardOptions {
  /** 守卫期间挂起的 openIntent claim（取消 → ackFailure；完成由动作内 ack）。 */
  claim?: OpenIntentClaim
  /** 取消钩子（非意图触发面的清理——如 handoff 取消即丢弃交接载荷）。 */
  onCancel?: () => void
}

let guardOpen = $state(false)
let guardBusy = $state(false)
let guardError = $state<string | null>(null)
let guardAction: (() => Promise<void>) | null = null
let guardClaim: OpenIntentClaim | null = null
let guardOnCancel: (() => void) | null = null

// ---------------------------------------------------------------------------
// 读取器（Dialog 渲染消费——StudioView 单实例挂载）
// ---------------------------------------------------------------------------

export function isStudioGuardOpen(): boolean {
  return guardOpen
}

export function isStudioGuardBusy(): boolean {
  return guardBusy
}

export function getStudioGuardError(): string | null {
  return guardError
}

// ---------------------------------------------------------------------------
// 入口 + 三按钮
// ---------------------------------------------------------------------------

/** 守卫入口：dirty → 三按钮 Dialog 挂起动作；干净 → 直行（守卫只拦破坏性动作，切 Tab 不在此面）。 */
export function runStudioGuarded(action: () => Promise<void>, options: StudioGuardOptions = {}): void {
  if (!isStudioDirty()) {
    void action()
    return
  }
  guardAction = action
  guardClaim = options.claim ?? null
  guardOnCancel = options.onCancel ?? null
  guardError = null
  guardOpen = true
}

/** 保存并继续：saveGemproj（④段链路）成功才放行；失败就地报错、Dialog 保持可改选「不保存」。 */
export async function studioGuardSaveAndContinue(): Promise<void> {
  if (guardBusy) return
  guardBusy = true
  try {
    await saveGemproj()
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
    return
  } finally {
    guardBusy = false
  }
  proceed()
}

/** 不保存：丢弃未保存修改直接放行（dirty 位不清——会话内容即将被动作替换，位随替换自然失效）。 */
export function studioGuardDiscard(): void {
  proceed()
}

function proceed(): void {
  guardOpen = false
  guardError = null
  guardClaim = null
  guardOnCancel = null
  const action = guardAction
  guardAction = null
  void action?.()
}

/** 取消：挂起意图 ackFailure + onCancel 清理；动作永不执行、会话原地保持。 */
export function studioGuardCancel(): void {
  const claim = guardClaim
  if (claim !== null) ackOpenIntentFailure(claim.token, 'gemproj-open-guard-cancelled')
  guardOnCancel?.()
  guardAction = null
  guardClaim = null
  guardOnCancel = null
  guardError = null
  guardOpen = false
}

/** 测试复位。 */
export function resetStudioGuardForTests(): void {
  guardOpen = false
  guardBusy = false
  guardError = null
  guardAction = null
  guardClaim = null
  guardOnCancel = null
}
