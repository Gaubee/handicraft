/**
 * templateSheet——素材库 gemtpl 编辑 RightSheet 的全局开关（openspec add-project-files
 * 4.3b；补充稿 §C.5.1 canonical handler `openTemplateSheet(templateAssetId)` 的 store 侧）。
 *
 * 设计要点：
 * - 单例 Sheet：AssetsView 挂载唯一 `<TemplateEditSheet/>`，本 store 是它唯一的 open 真源
 *   （assetId 非空 = open）。编辑内容一律走 templates store 共享 record——本 store **不持
 *   任何编辑态**（PRODUCT_MODEL 硬规则 7，C.5.3「宿主不持副本」）。
 * - 双宿主同开同一模板 = 同一 record 实时互见（构造性保证）：本 store 只记 assetId，
 *   换绑/回退/删除全部由 templates store 的共享状态机承接，无需冲突仲裁。
 * - 纯内存 $state、不持久化：刷新即关闭（与 openIntent/handoff 同口径）。
 * - 关闭语义分层：外部只应调 openTemplateSheet（打开/切换对象）；「关闭」是
 *   TemplateEditSheet 关闭状态机（flush → 成功才 closeTemplateSheet，design §9.3 E4）
 *   的内部动作——closeTemplateSheet 导出仅因 Sheet 组件与测试需要直达。
 */

import { getTemplateRecord } from './templates.svelte'

let sheetAssetId = $state<string | null>(null)

/**
 * 打开（或切换到另一模板的）编辑 RightSheet——C.5.1「去编辑」canonical handler。
 * 模板不存在（已删/未 hydrate）时静默不开：宿主对 undefined record 有「模板已删除」
 * 终态分支，但入口侧拦掉更省一次开合动画。
 */
export function openTemplateSheet(assetId: string): void {
  if (getTemplateRecord(assetId) === undefined) return
  sheetAssetId = assetId
}

/** 关闭（关闭状态机 flush 成功 / 放弃修改 / 编辑中删除终态的收口动作）。 */
export function closeTemplateSheet(): void {
  sheetAssetId = null
}

export function getTemplateSheetAssetId(): string | null {
  return sheetAssetId
}

export function isTemplateSheetOpen(): boolean {
  return sheetAssetId !== null
}

/** 测试专用：复位开关（不动 templates store / IDB）。 */
export function resetTemplateSheetForTests(): void {
  sheetAssetId = null
}
