/**
 * [2026-09-18 R3] 全局轻量 toast（自实现，不引依赖）：送排钻确认等跨视图反馈。
 * 语义：push 后自动到期消失；重复调用叠加为多条。
 */

export interface ToastItem {
	id: number
	message: string
}

const TOAST_DURATION_MS = 2600

let items = $state<ToastItem[]>([])
let seq = 0

export function getToasts(): ToastItem[] {
	return items
}

export function showToast(message: string, durationMs = TOAST_DURATION_MS): void {
	const id = ++seq
	items.push({ id, message })
	setTimeout(() => dismissToast(id), durationMs)
}

export function dismissToast(id: number): void {
	const index = items.findIndex((t) => t.id === id)
	if (index >= 0) items.splice(index, 1)
}

/** 测试专用：清空待展示条目（跳过的 setTimeout 回调对已消失 id 是 no-op） */
export function resetToastsForTests(): void {
	items.splice(0, items.length)
}
