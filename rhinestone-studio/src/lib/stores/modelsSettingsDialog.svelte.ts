/**
 * [zhumo 方案移植块 A 2026-09-28] 模型服务设置 Sheet 的全局开合状态。
 * 入口收敛为一处（App 顶栏「模型服务」按钮）；App 层唯一挂载
 * ModelsSettingsDialog（ModelsConfig 满高链容器——zhumo AdminPage 设置分区形态）。
 */

let open = $state(false)

export function isModelsSettingsOpen(): boolean {
  return open
}

export function openModelsSettings(): void {
  open = true
}

export function closeModelsSettings(): void {
  open = false
}
