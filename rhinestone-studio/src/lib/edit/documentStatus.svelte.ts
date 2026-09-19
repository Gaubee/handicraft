/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 rename-and-expert-workbench A 2.5] 文档状态位域（原 stores/edit.svelte.ts
 *    :154-192 相关状态位 + :717-733 身份读取器/重命名）纯搬移：dirty（$state）/savedBlobKey（CAS
 *    expectedBlobKey 真源）/gemdocLease（gemdoc 打开租约）+ EDIT_PROJECT_OWNER_ID + 释放编排。
 *    零行为变化；公共导出面经 store 根 re-export 兼容（design §2.3-1/2）。
 * 2. [$state 宿主纪律] dirty 为 $state——本文件为 .svelte.ts runes 宿主（design §2.3-5）。
 * 3. [内部协作面] markEditDirty/clearEditDirty/setSavedBlobKey/setGemdocLease/releaseGemdocLease
 *    仅为拆分子模块（gemdocLifecycle）与 store 根的消费面；非公共 API，签名不冻结。
 *    doc 读写经根公共读取器 getEditDoc（$state 代理引用，字段改写语义不变）。
 */

import { closeProject } from '$lib/persistence/assetStore'
import type { ProjectLease } from '$lib/persistence/projectTypes'
import { getEditDoc } from '$lib/stores/edit.svelte'

/** [3.2 dirty] 自上次保存以来有修改（A.2.3 口径；详见原文件头意图 6）。 */
let dirty = $state(false)

/** [3.2] 当前文档对应的库节点 blobKey（CAS 换绑的 expectedBlobKey 真源）。 */
let savedBlobKey: string | null = null

/** [3.2] gemdoc 打开租约（design §9.1 B5：gemdoc 仅 pin reference；ownerId 宿主稳定）。 */
let gemdocLease: ProjectLease | null = null

/** lease ownerId（design §9.1 B5 R3：宿主提供且宿主生命周期内稳定）。 */
export const EDIT_PROJECT_OWNER_ID = 'edit-page'

/** 释放 gemdoc 租约（幂等；closeProject 同步体——置空先行防重入）。内部协作面：根/装载域共用。 */
export function releaseGemdocLease(): void {
  const lease = gemdocLease
  gemdocLease = null
  if (lease) void closeProject(lease)
}

// —— 内部协作面（仅 store 根与 gemdocLifecycle 子模块消费；非公共 API，签名不冻结） ——

/** patch/图层/重命名路径置 dirty（自上次保存以来有修改）。 */
export function markEditDirty(): void {
  dirty = true
}

/** 保存成功/干净装载路径清 dirty。 */
export function clearEditDirty(): void {
  dirty = false
}

/** CAS 换绑真源写入（首次 ingest / 再次 update / 覆盖载入 / 关闭复位）。 */
export function setSavedBlobKey(blobKey: string | null): void {
  savedBlobKey = blobKey
}

/** CAS expectedBlobKey 读取（saveGemdoc 首存/换绑分支判据）。 */
export function getSavedBlobKey(): string | null {
  return savedBlobKey
}

/** gemdoc 租约写入（loadFromGemdoc 开租约后挂载；释放统一走 releaseGemdocLease）。 */
export function setGemdocLease(lease: ProjectLease): void {
  gemdocLease = lease
}

// ---------------------------------------------------------------------------
// 读取器（公共面，经 store 根 re-export 兼容）
// ---------------------------------------------------------------------------

/** [3.2 dirty 口径（A.2.3）] 未保存 = 自上次保存以来有修改（patch/图层/重命名）。
 *  守卫、●未保存徽标、「再次送精修」覆盖确认的共用出口；undo 不影响（撤销≠保存）；
 *  导出不清除。canUndo/canRedo 回归纯撤销可用性。 */
export function isEditDirty(): boolean {
  return dirty
}

// ---------------------------------------------------------------------------
// 项目身份读取器（摘要条 [▦]名● 消费）
// ---------------------------------------------------------------------------

export function getEditProjectIdentity(): { docId: string | null; name: string; savedAt: number | null } | null {
  const doc = getEditDoc()
  return doc === null ? null : { docId: doc.docId, name: doc.name, savedAt: doc.savedAt }
}

/** 重命名文档（入 gemdoc name 字段 → 变更即 dirty）。 */
export function setEditDocName(name: string): void {
  const doc = getEditDoc()
  if (!doc) return
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === doc.name) return
  doc.name = trimmed
  dirty = true
}
