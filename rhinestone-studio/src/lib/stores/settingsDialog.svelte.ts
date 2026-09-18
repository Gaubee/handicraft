/**
 * [2026-09-18 R1/R2] BYOK 设置 Dialog 的全局开合状态。
 * 连接配置入口收敛为一处：顶栏状态芯片、实验室 sticky CTA（未配置变体）、失败卡「去设置」
 * 都通过 openSettings() 打开 App 层唯一挂载的 SettingsDialog。
 */

let open = $state(false)

export function isSettingsOpen(): boolean {
	return open
}

export function openSettings(): void {
	open = true
}

export function closeSettings(): void {
	open = false
}
