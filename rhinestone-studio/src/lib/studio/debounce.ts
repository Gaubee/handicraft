/*
共享 trailing debounce 工具（[Owner 2026-09-19] loading/progress 切片）：
- 每个滑杆独立实例：同控件连续拖动合并为「末值一次提交」，不同控件互不吞并
- 可取消（cancel，丢弃 pending 末值）/ 可立即落地（flush，携带末值）/ pending 可查（isPending）
- 组件内使用模式：$effect(() => () => commit.cancel()) 实现卸载自动取消（迟到提交不落到新实例）
- SLIDER_COMMIT_DEBOUNCE_MS 与 store 既有 SEGMENT/LAYOUT_DEBOUNCE_MS 同为 300ms——
  全应用统一「停止交互 300ms 后生效」的时间语汇（连拖合并窗口内不触发计算轮）
*/

export const SLIDER_COMMIT_DEBOUNCE_MS = 300

export interface DebouncedFn<TArgs extends readonly unknown[]> {
  (...args: TArgs): void
  /** 取消 pending 调用：之后不再触发，pending 末值丢弃 */
  cancel(): void
  /** 立即落地 pending 调用（携带末值）；无 pending 时 no-op */
  flush(): void
  /** 是否存在待落地调用（UI 据此区分「已提交待生效」与「计算中」） */
  isPending(): boolean
}

export function createDebounce<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): DebouncedFn<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: TArgs | null = null

  function invokeNow(): void {
    const args = pendingArgs
    pendingArgs = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (args !== null) fn(...args)
  }

  const debounced = (...args: TArgs): void => {
    // trailing 语义：新输入取消 pending 定时器（不排队旧值），只记末值
    pendingArgs = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(invokeNow, delayMs)
  }
  debounced.cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pendingArgs = null
  }
  debounced.flush = invokeNow
  debounced.isPending = (): boolean => timer !== null
  return debounced
}
