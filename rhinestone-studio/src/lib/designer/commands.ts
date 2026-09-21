/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 命令总线（design §7.2 同源
 *    纪律）：键位（keymap §3 表）/ 右键菜单（§2.2 树）/ 面板按钮全部收敛 execDesignerCommand
 *    单入口——禁第二实现。命令面：编辑（复制/剪切/粘贴/删除（单颗直删可撤销，≥2 颗经
 *    UI 确认钩子——全局纪律删除=确认，briefing 裁决批量才确认）/全选当前层/取消选择）、
 *    变换（[ ] 旋转步进 ±15°/±5°——批量逐钻朝向步进，单 undo 组）、对齐分布（≥2/≥3 门控
 *    在调用方 UI）、移入图层（moveGemsToLayer 单 op）、视图（⌘+/-/0/1 经 viewport 宿主）、
 *    文档（[5.3] open-save/save-as 经 UI 钩子——保存/另存编排复用 gemdocLifecycle+documentService，
 *    本域零生命周期实现；⌘S/⌘⇧S 与 DocBar 按钮/菜单同源单入口）、[6.1] 图层操作组（§3.5：
 *    new-layer ⌘⇧N / merge-layer-down ⌘E（mergeDownTargetOf 同源解析）/ reorder-layer
 *    ⌘[ ⌘] ⌘⇧[ ⌘⇧]（z 序数组序 op——与图层面板上下移/置序按钮同命令））。
 * 2. [redesign 3.2] apply-spec（design §6.2 规格选择器/右键「改规格▸」唯一写入口）：
 *    形×档×色三元组——① 选中钻 ≥1 = 批量改规格（单 undo 组：shapeId/diameterMm/colorId/
 *    assetId 四键对称，custom⇄builtin 双向）；② 恒写 brushSpec 真源（当前规格跟随）+
 *    custom 形先行 prefetch 资产解析（missing-asset 拒画防线前置）；③ 最近使用规格记录。
 *    open-spec-selector = 右键「更多…」打开规格选择器（经 UI 钩子——delete-selection 同源模式）。
 * 3. [Undo 纪律] 每命令 = 单 patch（或 begin/endStroke 单组）——一个 undo 组；值未变/
 *    门槛不满足返回 false（键位层据此放行浏览器默认）。
 */

import {
  addGemLayer,
  applyPatch,
  clearSelection,
  getEditDoc,
  mergeDownTargetOf,
  mergeGemLayersBatch,
  moveGemsToLayer,
  setSelection,
  type DesignerGem,
  type GemLayerRecord,
} from '$lib/stores/edit.svelte'
import { customAssetIdMissing, isBuiltinShapeId } from '$lib/engine'
import { applyGemChanges } from './gemCommands'
import {
  buildAlignChanges,
  buildDistributeChanges,
  type AlignMode,
  type DistributeMode,
} from './alignDistribute'
import { buildSpecChanges, pushRecentSpec } from './specSelector.svelte'
import { normalizeDeg } from './gestures'
import { currentLayerIdOf, getCurrentLayerId, setCurrentLayerId, setBrushSpec, type BrushSpecState } from './workbench.svelte'
import { brushAssetStatusOf, resolveBrushAsset } from './brushEngine'
import { viewportFit, viewportZoomStep, viewportZoomTo } from './viewport.svelte'
import { setCanvasPopoverOpen } from './viewState.svelte'
import { setSmartLayoutOpen, smartLayoutUnderlayReady } from './smartLayout.svelte'
import * as clipboard from './clipboard'

export type DesignerCommand =
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'delete-selection' }
  | { kind: 'delete-selection-confirm' }
  | { kind: 'select-all-current-layer' }
  | { kind: 'deselect' }
  | { kind: 'rotate'; stepDeg: number }
  | { kind: 'align'; mode: AlignMode }
  | { kind: 'distribute'; mode: DistributeMode }
  | { kind: 'move-to-layer'; layerId: string }
  /** [3.2] 应用规格（形×档×色）：选中钻 = 批量改规格（单 undo 组）+ 恒写 brushSpec 真源。 */
  | { kind: 'apply-spec'; spec: BrushSpecState; label?: string }
  /** [3.2] 打开规格选择器（右键「更多…」——经 UI 钩子，delete-selection 同源模式）。 */
  | { kind: 'open-spec-selector' }
  | { kind: 'zoom-in' }
  | { kind: 'zoom-out' }
  | { kind: 'zoom-fit' }
  | { kind: 'zoom-100' }
  /** [5.3] 保存（⌘S/DocBar 按钮/菜单同源——经 UI 钩子：直存 vs 首存命名弹窗归视图）。 */
  | { kind: 'open-save' }
  /** [5.3] 另存为（⌘⇧S/文档菜单「另存为…」同源——经 UI 钩子弹命名）。 */
  | { kind: 'save-as' }
  /** [6.1 图层操作组 §3.5] 新建图层（⌘⇧N / 图层面板「＋新建」同源；尾部追加 = z 序最上）。 */
  | { kind: 'new-layer' }
  /** [6.1 §3.5] 向下合并（⌘E = 当前层；面板指定层传 layerId——mergeDownTargetOf 同源解析：
   *  目标 = z 序向下最近可见未锁层；单 op + 源层为当前层时当前层改指目标层）。 */
  | { kind: 'merge-layer-down'; layerId?: string }
  /** [6.1 §3.5] 层排序（⌘[ ⌘] 下移/上移一层、⌘⇧[ ⌘⇧] 置底/置顶 = 当前层；面板上下移按钮
   *  传 layerId——z 序数组序 op，与面板按钮同命令，不改 gems[] 真源序）。 */
  | { kind: 'reorder-layer'; layerId?: string; to: 'down' | 'up' | 'bottom' | 'top' }
  /** [6.2 右键空态树] 智能排布…（design §2.2/§5.3——打开 7.2 参数小窗；无参考底图门槛
   *  smartLayoutUnderlayReady 同源，DocBar 按钮/菜单项/命令三口同判据）。 */
  | { kind: 'open-smart-layout' }
  /** [6.2 右键空态树] 画幅设置…（design §2.2——打开 5.2 canvas popover，状态栏读数
   *  点击同源 toggle；popover 态在 viewState 单真源）。 */
  | { kind: 'open-canvas-popover' }

/** UI 钩子（视图安装）：破坏性确认/选择器唤起等需要 DOM 的命令面。 */
export interface DesignerUiHooks {
  /** 批量删除确认（≥2 颗）；确认后视图回调 delete-selection-confirm。 */
  requestDeleteConfirm(count: number): void
  /** [3.2] 打开规格选择器（右键「更多…」/命令入口 → 顶栏选择器弹层）。 */
  requestOpenSpecSelector(): void
  /** [5.3] 保存（⌘S / DocBar 保存按钮同源）：docId 已有 = 直存；首存 = 命名弹窗（视图装配）。 */
  requestSave(): void
  /** [5.3] 另存为（⌘⇧S / 文档菜单「另存为…」同源）：命名弹窗（视图装配）。 */
  requestSaveAs(): void
}

let uiHooks: DesignerUiHooks | null = null

/** 视图挂载安装 / 卸载注销（不安装时删除命令退化为直删——测试/无视图面）。 */
export function installDesignerUiHooks(hooks: DesignerUiHooks | null): void {
  uiHooks = hooks
}

function selectedGems(): DesignerGem[] {
  const doc = getEditDoc()
  if (doc === null) return []
  const byId = new Map(doc.gems.map((g) => [g.id, g] as const))
  const out: DesignerGem[] = []
  for (const id of doc.selection) {
    const gem = byId.get(id)
    if (gem) out.push(gem)
  }
  return out
}

/** 删除一批钻（单 remove patch = 一个 undo 组；选集清空）。 */
function removeGems(gems: readonly DesignerGem[]): boolean {
  const doc = getEditDoc()
  if (doc === null || gems.length === 0) return false
  const result = applyPatch({
    op: 'remove',
    items: gems.map((gem) => ({ gem, index: doc.gems.indexOf(gem) })),
  })
  if (result.ok) clearSelection()
  return result.ok
}

/** 批量朝向步进（[ ] / ⇧[ ]：逐钻 rotationDeg ± step，归一 [0,360)；单 undo 组）。 */
function rotateSelection(stepDeg: number): boolean {
  const selected = selectedGems()
  if (selected.length === 0) return false
  const changes = selected
    .map((gem) => {
      const before = gem.rotationDeg ?? 0
      const after = Math.round(normalizeDeg(before + stepDeg) * 100) / 100
      return { id: gem.id, before: { rotationDeg: before }, after: { rotationDeg: after } }
    })
    .filter((change) => change.before.rotationDeg !== change.after.rotationDeg)
  if (changes.length === 0) return false
  return applyGemChanges(changes)
}

/** 全选当前层钻（design §3.3 ⌘A：非全文档——当前层语义优先；锁定/隐藏层不选）。 */
function selectAllCurrentLayer(): boolean {
  const doc = getEditDoc()
  if (doc === null) return false
  const layerId = currentLayerIdOf(doc)
  if (layerId === null) return false
  const layer = doc.layers.find((l) => l.id === layerId)
  if (layer === undefined || layer.locked || !layer.visible) return false
  const ids = doc.gems.filter((g) => g.layerId === layerId).map((g) => g.id)
  if (ids.length === 0) return false
  setSelection(ids)
  return true
}

/**
 * [6.1 §3.5] 层排序 patch 构造（z 序数组序 op——before/after 整组快照；纯函数）：
 * 无位移（已目标位）/层不存在返回 null（命令返回 false——键位层放行浏览器默认）。
 */
function buildReorderLayerPatch(
  layers: readonly GemLayerRecord[],
  id: string,
  to: 'down' | 'up' | 'bottom' | 'top',
): { before: GemLayerRecord[]; after: GemLayerRecord[] } | null {
  const i = layers.findIndex((l) => l.id === id)
  if (i < 0) return null
  const next = layers.map((l) => ({ ...l }))
  const [moved] = next.splice(i, 1)
  const j =
    to === 'up' ? Math.min(i + 1, next.length)
    : to === 'down' ? Math.max(i - 1, 0)
    : to === 'top' ? next.length
    : 0
  if (j === i) return null
  next.splice(j, 0, moved)
  return { before: layers.map((l) => ({ ...l })), after: next }
}

/**
 * 执行命令；返回是否实际生效（false = 门槛不满足/无变更/无宿主——键位层放行默认）。
 */
export function execDesignerCommand(cmd: DesignerCommand): boolean {
  switch (cmd.kind) {
    case 'copy':
      return clipboard.copyGems(selectedGems())
    case 'cut': {
      const selected = selectedGems()
      if (!clipboard.copyGems(selected)) return false
      return removeGems(selected)
    }
    case 'paste':
      return clipboard.pasteClipboard()
    case 'delete-selection': {
      const selected = selectedGems()
      if (selected.length === 0) return false
      // 单颗直删（可撤销）；批量经确认钩子（全局纪律：删除=确认——briefing 批量才确认）
      if (selected.length === 1 || uiHooks === null) return removeGems(selected)
      uiHooks.requestDeleteConfirm(selected.length)
      return true
    }
    case 'delete-selection-confirm':
      return removeGems(selectedGems())
    case 'select-all-current-layer':
      return selectAllCurrentLayer()
    case 'deselect': {
      const doc = getEditDoc()
      if (doc === null || doc.selection.size === 0) return false
      clearSelection()
      return true
    }
    case 'rotate':
      return rotateSelection(cmd.stepDeg)
    case 'align': {
      const changes = buildAlignChanges(selectedGems(), cmd.mode)
      if (changes.length === 0) return false
      return applyGemChanges(changes)
    }
    case 'distribute': {
      const changes = buildDistributeChanges(selectedGems(), cmd.mode)
      if (changes === null || changes.length === 0) return false
      return applyGemChanges(changes)
    }
    case 'move-to-layer': {
      const doc = getEditDoc()
      if (doc === null || doc.selection.size === 0) return false
      const result = moveGemsToLayer(doc.selection, cmd.layerId)
      return result.ok
    }
    case 'apply-spec': {
      const spec = cmd.spec
      // 判据守卫（setBrushSpec 同判据先行——不产半执行：批量与真源要么都写要么都不写）
      if (customAssetIdMissing(spec)) return false
      if (isBuiltinShapeId(spec.shapeId) && spec.assetId !== undefined) return false
      // ① 选中钻 ≥1 = 批量改规格（单 undo 组；全等钻不入 changes——无变更不产组）
      const selected = selectedGems()
      if (selected.length > 0) {
        const changes = buildSpecChanges(selected, spec)
        if (changes.length > 0 && !applyGemChanges(changes)) return false
      }
      // ② 当前规格跟随：恒写 brushSpec 真源 + custom 形 prefetch 资产解析（拒画防线前置）
      setBrushSpec(spec)
      if (spec.shapeId === 'custom' && spec.assetId !== undefined && brushAssetStatusOf(spec.assetId) === 'pending') {
        void resolveBrushAsset(spec.assetId)
      }
      // ③ 最近使用规格（右键「改规格▸」数据源）
      pushRecentSpec(spec, cmd.label ?? '')
      return true
    }
    case 'open-spec-selector': {
      if (uiHooks === null) return false
      uiHooks.requestOpenSpecSelector()
      return true
    }
    case 'zoom-in':
      return viewportZoomStep(1.25)
    case 'zoom-out':
      return viewportZoomStep(0.8)
    case 'zoom-fit':
      return viewportFit()
    case 'zoom-100':
      return viewportZoomTo(1)
    // [5.3] 文档命令（design §3「⌘S/⌘⇧S」+ §5.4 守卫三分法）：编排归 documentService +
    // gemdocLifecycle 复用（本域零生命周期实现），经 UI 钩子到视图装配；无文档/无钩子放行。
    case 'open-save': {
      if (getEditDoc() === null || uiHooks === null) return false
      uiHooks.requestSave()
      return true
    }
    case 'save-as': {
      if (getEditDoc() === null || uiHooks === null) return false
      uiHooks.requestSaveAs()
      return true
    }
    // [6.1 图层操作组]（design §3.5——键位 ⌘⇧N/⌘E/⌘[ ⌘] ⌘⇧[ ⌘⇧] 与图层面板按钮同源单入口）
    case 'new-layer':
      return addGemLayer() !== null
    case 'merge-layer-down': {
      const doc = getEditDoc()
      if (doc === null) return false
      const sourceId = cmd.layerId ?? currentLayerIdOf(doc)
      if (sourceId === null) return false
      // ⌘E 目标解析与面板「向下合并」同源（mergeDownTargetOf 单一实现——禁第二实现）
      const targetId = mergeDownTargetOf(doc.layers, sourceId)
      if (targetId === null) return false
      const result = mergeGemLayersBatch([sourceId], targetId)
      if (!result.ok) return false
      // 源层被删：当前层落在源层时改指目标层（不持悬空 id——与面板 mergeDown 同式）
      if (getCurrentLayerId() === sourceId) setCurrentLayerId(targetId, getEditDoc())
      return true
    }
    case 'reorder-layer': {
      const doc = getEditDoc()
      if (doc === null) return false
      const layerId = cmd.layerId ?? currentLayerIdOf(doc)
      if (layerId === null) return false
      const patch = buildReorderLayerPatch(doc.layers, layerId, cmd.to)
      if (patch === null) return false
      return applyPatch({ op: 'layers', ...patch }).ok
    }
    // [6.2 右键空态树缺口]（design §2.2：智能排布…/画幅设置…——经命令总线同源打开）
    case 'open-smart-layout': {
      const doc = getEditDoc()
      if (doc === null || !smartLayoutUnderlayReady(doc)) return false
      setSmartLayoutOpen(true)
      return true
    }
    case 'open-canvas-popover': {
      if (getEditDoc() === null) return false
      setCanvasPopoverOpen(true)
      return true
    }
  }
}
