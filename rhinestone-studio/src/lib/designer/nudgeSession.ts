/*
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.5 rename-and-expert-workbench；2026-09-21 迁移至 lib/designer] 方向键
 *    微移的按键会话合组 undo：keydown 起至 500ms 无新按键为一组——会话内所有 nudge patch
 *    并入同一 stroke 组，静默期满提交；组大小 = 一次 undo 的回退面。
 *    语义不变迁移（design §7.4 退役清单「迁移」行）。
 * 2. [2026-09-20 Pure] 依赖注入（edit store 三函数）——vitest 用假 store + fake timers
 *    直接驱动会话语义，不挂 DOM。
 */

import type { EditGem } from '$lib/engine'
import type { EditPatch, PatchResult } from '$lib/stores/edit.svelte'

/** 会话静默合组窗口（ms）：最后一次按键起算。 */
export const NUDGE_SESSION_IDLE_MS = 500

export interface NudgeSessionDeps {
  beginStroke(): void
  endStroke(): void
  applyPatch(patch: EditPatch): PatchResult
}

/**
 * 按键会话：首次 nudge 开 stroke 组并起 500ms 定时器；窗口内新 nudge 清旧定时重起
 * （并入同组）；定时器到点 endStroke 提交。flush() 供视图卸载/测试立即收组。
 */
export class NudgeSession {
  private readonly deps: NudgeSessionDeps
  private timer: ReturnType<typeof setTimeout> | null = null
  private open = false

  constructor(deps: NudgeSessionDeps) {
    this.deps = deps
  }

  get isOpen(): boolean {
    return this.open
  }

  /** 微移一批钻（dx/dy 为 0 的轴不入 patch——字段级回退最小面）。 */
  nudge(gems: readonly EditGem[], dx: number, dy: number): boolean {
    if (gems.length === 0 || (dx === 0 && dy === 0)) return false
    const changes = gems.map((gem) => ({
      id: gem.id,
      before: {
        ...(dx !== 0 ? { x: gem.x } : {}),
        ...(dy !== 0 ? { y: gem.y } : {}),
      },
      after: {
        ...(dx !== 0 ? { x: gem.x + dx } : {}),
        ...(dy !== 0 ? { y: gem.y + dy } : {}),
      },
    }))
    if (!this.open) {
      this.deps.beginStroke()
      this.open = true
    }
    const result = this.deps.applyPatch({ op: 'update', changes })
    this.scheduleCommit()
    return result.ok
  }

  private scheduleCommit(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, NUDGE_SESSION_IDLE_MS)
  }

  /** 立即收组（开组时提交；幂等）。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.open) {
      this.open = false
      this.deps.endStroke()
    }
  }
}
