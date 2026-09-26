<!--
WorkbenchStatusBar.svelte — 画布底部状态栏（add-workbench-pro 2c 状态栏 P0）。
读数：zoom%（CanvasView.scale）｜指针坐标 px↔mm（pointerImage+ppm 换算）｜
ppm 三态（真实=derivePixelsPerMm 可推导/未知=无画布锚/降级=纵横比不吻合——
降级值不伪装真实读数，Codex 一轮风险[5]）｜选中层名+尺寸（bbox px+mm）｜
dirty（未提交遮罩编辑笔画数）｜降级告警（maskEdits incomplete/stale/error 聚合）
｜undo 当前域（路由所见即所撤）。
-->

<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { getCanvasView, getPointerImage } from './canvasStage.svelte.js'
  import {
    getBrushSession,
    getCurrentUndoDomainLabel,
    getMaskEditOf,
    getNodeOf,
    getSelectedNodeId,
    getWorkbenchCanvasModel,
    getWorkbenchNodes,
  } from './store.svelte'

  const model = $derived(getWorkbenchCanvasModel())
  const view = $derived(getCanvasView())
  const pointer = $derived(getPointerImage())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const brush = $derived(getBrushSession())
  const undoLabel = $derived(getCurrentUndoDomainLabel())

  /** ppm 三态：真实（exact）/未知（无画布锚）/降级（不可推导——回退值如实标注）。 */
  const ppmReadout = $derived.by(() => {
    if (model === null) return { kind: 'unknown' as const, text: 'ppm 未知' }
    if (model.ppm.exact) return { kind: 'exact' as const, text: `ppm ${model.ppm.ppm.toFixed(2)}` }
    return {
      kind: 'fallback' as const,
      text: `ppm 不可推导（回退 ${model.ppm.ppm} 渲染）`,
    }
  })

  /** 指针坐标 px↔mm（画布域外=空读数；mm=px/ppm——降级 ppm 下的 mm 读数按回退值标注）。 */
  const pointerReadout = $derived.by(() => {
    if (pointer === null || model === null) return null
    const mmX = pointer.x / model.ppm.ppm
    const mmY = pointer.y / model.ppm.ppm
    return {
      px: `${Math.round(pointer.x)}, ${Math.round(pointer.y)} px`,
      mm: `${mmX.toFixed(1)}, ${mmY.toFixed(1)} mm${model.ppm.exact ? '' : '（回退口径）'}`,
    }
  })

  /** 选中层尺寸（bbox px+mm——mm 按当前 ppm 口径）。 */
  const selectedReadout = $derived.by(() => {
    if (selectedNode === null || model === null) return null
    const { bbox } = selectedNode
    return {
      name: selectedNode.objectName,
      px: `${bbox.w}×${bbox.h} px`,
      mm: `${(bbox.w / model.ppm.ppm).toFixed(0)}×${(bbox.h / model.ppm.ppm).toFixed(0)} mm`,
    }
  })

  /** 降级告警聚合（maskEdits incomplete/stale/error——导出门阻断面）。 */
  const maskWarnings = $derived.by(() => {
    const summary = { incomplete: 0, stale: 0, error: 0 }
    for (const node of getWorkbenchNodes()) {
      const edit = getMaskEditOf(node.id)
      if (edit === null) continue
      if (edit.incomplete) summary.incomplete += 1
      if (edit.state === 'stale') summary.stale += 1
      if (edit.state === 'error') summary.error += 1
    }
    return summary
  })

  const dirtyCount = $derived(brush.strokes.length + (brush.previewPoints.length > 0 ? 1 : 0))
</script>

<div
  class="bg-background/80 flex h-6 shrink-0 items-center gap-3 border-t px-3 font-mono text-[10px] backdrop-blur"
  data-testid="workbench-status-bar"
  role="status"
  aria-label="画布状态栏"
>
  <span data-testid="workbench-status-zoom">{Math.round(view.scale * 100)}%</span>
  <span class="text-muted-foreground" data-testid="workbench-status-ppm" title="像素/毫米换算（derivePixelsPerMm 同源推导）">
    {ppmReadout.text}
  </span>
  <span data-testid="workbench-status-pointer">
    {#if pointerReadout !== null}
      {pointerReadout.px} · {pointerReadout.mm}
    {:else}
      <span class="text-muted-foreground/60">—, —</span>
    {/if}
  </span>
  {#if selectedReadout !== null}
    <span class="text-muted-foreground max-w-48 truncate" data-testid="workbench-status-selected" title={selectedReadout.name}>
      {selectedReadout.name} · {selectedReadout.px} · {selectedReadout.mm}
    </span>
  {:else}
    <span class="text-muted-foreground/60" data-testid="workbench-status-selected">未选中层</span>
  {/if}
  {#if dirtyCount > 0}
    <span class="text-amber-600" data-testid="workbench-status-dirty" title="提交前笔画（⌘Z mask 域逐笔撤销）">
      未提交编辑 {dirtyCount} 笔
    </span>
  {/if}
  {#if maskWarnings.incomplete + maskWarnings.stale + maskWarnings.error > 0}
    <span class="text-destructive flex items-center gap-1" data-testid="workbench-status-warnings" role="alert">
      <TriangleAlert class="size-2.5" aria-hidden="true" />
      遮罩告警{maskWarnings.incomplete > 0 ? `·超限 ${maskWarnings.incomplete}` : ''}{maskWarnings.stale > 0 ? `·漂移 ${maskWarnings.stale}` : ''}{maskWarnings.error > 0 ? `·重算失败 ${maskWarnings.error}` : ''}
    </span>
  {/if}
  <span class="text-muted-foreground/70 ml-auto" data-testid="workbench-status-undo-domain" title="Ctrl+Z 将回退的域（焦点路由——D-3）">
    undo 域：{undoLabel}
  </span>
</div>
