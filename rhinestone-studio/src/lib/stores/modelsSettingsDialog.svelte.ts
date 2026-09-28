/**
 * [zhumo 方案移植块 A 2026-09-28] 设置 Sheet（原「模型服务设置」）的全局开合+分区状态。
 * 入口收敛为一处（App 顶栏「设置」按钮）；App 层唯一挂载 ModelsSettingsDialog
 * （list-detail 多分区壳：模型服务 / 图像处理——zhumo AdminPage 设置分区形态）。
 * 分区语义（add-image-processing-settings 2.2）：openModelsSettings(section?) 缺省
 * 'models'——不做「保持上次分区」记忆（选简单：显式缺省更可预测，入口恒落模型
 * 服务；直达图像处理经 openModelsSettings('image-processing')）；Sheet 内部切换
 * 经 setSettingsSection；resetModelsSettingsForTests 供测试间复位。
 */

/** 设置分区标识（list-detail 左侧导航项）。 */
export type SettingsSection = 'models' | 'image-processing'

let open = $state(false)
let section = $state<SettingsSection>('models')

export function isModelsSettingsOpen(): boolean {
  return open
}

export function getSettingsSection(): SettingsSection {
  return section
}

export function setSettingsSection(next: SettingsSection): void {
  section = next
}

export function openModelsSettings(target: SettingsSection = 'models'): void {
  section = target
  open = true
}

export function closeModelsSettings(): void {
  open = false
}

/** 测试复位（vitest 文件间 store 模块级 $state 不自动重建）。 */
export function resetModelsSettingsForTests(): void {
  open = false
  section = 'models'
}
