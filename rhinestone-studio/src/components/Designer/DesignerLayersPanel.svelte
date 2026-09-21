<!--
 * DesignerLayersPanel.svelte——图层面板（design §1.2「右侧面板列·下图层」+ §4 图层系统完整功能）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x 骨架 → 4.1 完整功能] 参考底层钉底行
 *    （design §4.2：聚合眼睛=各源 visible 之 AND 派生、点击全开/全关；展开三源行——
 *    每源独立眼睛+透明度滑杆（R1-P0-3 源级显示态）+ 源展开详情（载荷摘要））+
 *    钻石层行列表（doc.layers z 序倒排展示：末位最上）。
 * 2. [4.1 层行五操作（design §2 P13-P17/§3.5/§4.3）] 选层（单击层名）/ 双击层名重命名 /
 *    眼睛显隐 + **Alt 孤立显示**（其余全隐藏，再按恢复——P17；快照存 workbench 真源）/
 *    锁定 / z 序上下移（数组序 op——不改 gems[] 真源序纪律）/ 新建 / 删除（ConfirmDialog
 *    含钻数确认；末层保底；层内钻随层删=单 undo）/ **向下合并**（目标=下一可见未锁层
 *    mergeDownTargetOf 纯函数同源——⌘E 键位 6.x 接线同一解析；层配置冲突取目标层）/
 *    **移入选中钻**（选中钻 layerId 批量改写该层——moveGemsToLayer 单 op；禁用态按真实
 *    归属 + 锁定/隐藏目标禁用，吸取排钻移入 BUG 教训 design §4.3）。
 *    [6.1 同源接线] 新建/上下移/向下合并三组按钮经命令总线（new-layer/reorder-layer/
 *    merge-layer-down）——与 ⌘⇧N/⌘[ ⌘] ⌘⇧[ ⌘⇧]/⌘E 键位同命令（design §7.2 禁第二实现）。
 * 3. [Guard] 无文档整面板不渲染（消费面随 doc）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import SliderField from '../Studio/SliderField.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import {
    applyPatch,
    beginStroke,
    endStroke,
    getEditDoc,
    mergeDownTargetOf,
    moveGemsToLayer,
    renameGemLayer,
    setGemLayerLocked,
    setGemLayerOpacity,
    setGemLayerVisible,
    setUnderlaySourceOpacity,
    setUnderlaySourceVisible,
    type GemLayerRecord,
    type UnderlaySourceKey,
  } from '$lib/stores/edit.svelte'
  import { execDesignerCommand } from '$lib/designer/commands'
  import {
    currentLayerIdOf,
    getIsolateSnapshot,
    setCurrentLayerId,
    setIsolateSnapshot,
  } from '$lib/designer/workbench.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Lock from '@lucide/svelte/icons/lock'
  import LockOpen from '@lucide/svelte/icons/lock-open'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Merge from '@lucide/svelte/icons/merge'
  import Import from '@lucide/svelte/icons/import'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'

  const doc = $derived(getEditDoc())
  /** 展示序 = 渲染序倒排（上 = 最上层：钻石层 z 序倒序 → 参考底层钉底）。 */
  const layersReversed = $derived(doc ? [...doc.layers].reverse() : [])
  const underlaySources = $derived(doc?.underlay.sources ?? [])
  /** 聚合眼睛 = 各源 visible 之 AND（派生态，不持久化——design §4.2）。 */
  const underlayAllVisible = $derived(underlaySources.length > 0 && underlaySources.every((s) => s.visible))
  const currentLayer = $derived(currentLayerIdOf(doc))
  /** Alt 孤立显示进行中（workbench 快照真源——两面板实例共态）。 */
  const isolating = $derived(getIsolateSnapshot() !== null)

  /** 选中钻的归属层集合（移入按钮禁用态按真实归属——design §4.3）。 */
  const selectedLayerIds = $derived.by(() => {
    const d = doc
    const out = new Set<string>()
    if (!d || d.selection.size === 0) return out
    const byId = new Map(d.gems.map((g) => [g.id, g.layerId] as const))
    for (const id of d.selection) {
      const layerId = byId.get(id)
      if (layerId !== undefined) out.add(layerId)
    }
    return out
  })
  const selectionCount = $derived(doc?.selection.size ?? 0)

  let underlayExpanded = $state(false)
  /** 源展开详情（每源独立——R1-P0-3：源级态 + 载荷摘要）。 */
  let expandedSources = new SvelteSet<UnderlaySourceKey>()

  const SOURCE_LABELS: Record<UnderlaySourceKey, string> = {
    painting: '数字油画',
    reference: '原图',
    blocks: '分块描线',
  }
  /** 展示序：blocks 最上 → reference → painting 最底（与渲染序一致：后画者在上）。 */
  const sourceOrder: UnderlaySourceKey[] = ['blocks', 'reference', 'painting']

  function toggleUnderlayAll(): void {
    const next = !underlayAllVisible
    for (const source of underlaySources) setUnderlaySourceVisible(source.key, next)
  }

  function selectLayer(id: string): void {
    setCurrentLayerId(id, doc)
  }

  // ---- 重命名（P15/§3.5：双击层名 → 行内输入；Enter/失焦提交、Esc 取消） ----

  let renamingId = $state<string | null>(null)
  let renameDraft = $state('')
  /** [走查3 P2-1] 行内输入元素（出现即 focus——下 $effect 挂载后聚焦）。 */
  let renameInputEl = $state<HTMLInputElement | null>(null)

  // [走查3 P2-1] 重命名输入框出现即 focus()（上轮「图层消失」观感疑点根因：空名 + 无聚焦
  // 的输入框残留——聚焦即打字面可见，Enter/失焦提交链路立即可达）。
  $effect(() => {
    if (renamingId !== null) renameInputEl?.focus()
  })

  function beginRename(layer: GemLayerRecord): void {
    renamingId = layer.id
    renameDraft = layer.name
  }

  function commitRename(): void {
    if (renamingId !== null) renameGemLayer(renamingId, renameDraft)
    renamingId = null
  }

  function cancelRename(): void {
    renamingId = null
  }

  // ---- 显隐 / Alt 孤立显示（P17：其余全隐藏，再按恢复——快照存 workbench） ----

  function toggleLayerVisible(layer: GemLayerRecord, event: MouseEvent): void {
    if (event.altKey) {
      toggleIsolate(layer.id)
      return
    }
    setGemLayerVisible(layer.id, !layer.visible)
  }

  function toggleIsolate(layerId: string): void {
    const d = doc
    if (!d) return
    const snapshot = getIsolateSnapshot()
    if (snapshot !== null) {
      // 孤立态再按 Alt+眼睛 = 按快照恢复全部层（「再按恢复」）
      for (const [id, visible] of Object.entries(snapshot)) setGemLayerVisible(id, visible)
      setIsolateSnapshot(null)
      return
    }
    const next: Record<string, boolean> = {}
    for (const layer of d.layers) {
      next[layer.id] = layer.visible
      setGemLayerVisible(layer.id, layer.id === layerId)
    }
    setIsolateSnapshot(next)
  }

  // ---- z 序上下移（数组序 op 单组可撤销——不改 gems[] 真源序纪律；拖排归 9.3 真浏览器走查；
  //      [6.1] 经命令总线 reorder-layer——与 ⌘[ ⌘] ⌘⇧[ ⌘⇧] 键位同命令（design §3.5 同源纪律）） ----

  function moveLayer(id: string, dir: -1 | 1): void {
    execDesignerCommand({ kind: 'reorder-layer', layerId: id, to: dir > 0 ? 'up' : 'down' })
  }

  // ---- 向下合并（design §4.3：目标=下一可见未锁层；单 op；配置冲突取目标层；
  //      [6.1] 经命令总线 merge-layer-down——与 ⌘E 键位同命令（mergeDownTargetOf 同源解析）） ----

  /** 目标层名（title 文案用；无候选 = null）。 */
  function mergeDownTargetName(layer: GemLayerRecord): string | null {
    const d = doc
    if (!d) return null
    const targetId = mergeDownTargetOf(d.layers, layer.id)
    if (targetId === null) return null
    return d.layers.find((l) => l.id === targetId)?.name ?? null
  }

  function mergeDown(layer: GemLayerRecord): void {
    execDesignerCommand({ kind: 'merge-layer-down', layerId: layer.id })
  }

  // ---- 移入选中钻（design §4.3：选中钻 layerId 批量改写该层；单 op；禁用态按真实归属） ----

  /** 移入禁用判定：无选中 / 选中钻已全在该层（无真实变更）/ 目标锁定或隐藏（§2.2 禁用纪律）。 */
  function intakeDisabled(layer: GemLayerRecord): boolean {
    if (selectionCount === 0) return true
    if (layer.locked || !layer.visible) return true
    // 选中钻的归属层集合 ⊆ {该层} → 全部已在目标层，无真实归属变更
    let other = false
    for (const id of selectedLayerIds) {
      if (id !== layer.id) {
        other = true
        break
      }
    }
    return !other
  }

  function intakeSelection(layer: GemLayerRecord): void {
    const d = doc
    if (!d || intakeDisabled(layer)) return
    moveGemsToLayer(d.selection, layer.id)
  }

  // ---- 删除层（ConfirmDialog 含钻数确认；末层保底；单 undo 组） ----

  let deleteTarget = $state<GemLayerRecord | null>(null)
  const deleteTargetGemCount = $derived.by(() => {
    const target = deleteTarget
    if (target === null) return 0
    return doc?.gems.filter((g) => g.layerId === target.id).length ?? 0
  })
  const lastLayerGuard = $derived(doc !== null && doc.layers.length <= 1)

  function requestDeleteLayer(layer: GemLayerRecord): void {
    deleteTarget = layer
  }

  /** 层内钻随层删除：remove + layers 双 patch stroke 合组 = 一次撤销恢复全部（design §4.3）。 */
  function confirmDeleteLayer(): void {
    const d = doc
    const layer = deleteTarget
    if (!d || !layer) return
    deleteTarget = null
    const items = d.gems
      .map((gem, index) => ({ gem, index }))
      .filter((it) => it.gem.layerId === layer.id)
    const after = d.layers.filter((l) => l.id !== layer.id).map((l) => ({ ...l }))
    beginStroke()
    if (items.length > 0) applyPatch({ op: 'remove', items })
    applyPatch({ op: 'layers', before: d.layers.map((l) => ({ ...l })), after })
    endStroke()
  }

  /** 源详情文案（载荷摘要——展开行显示，纯只读）。 */
  function sourceDetail(key: UnderlaySourceKey): string {
    const d = doc
    if (!d) return ''
    switch (key) {
      case 'painting':
        return `数字油画快照 · ${d.paintingSnapshot.width}×${d.paintingSnapshot.height}px`
      case 'reference':
        return d.referenceAssetId !== null ? `素材资产 · ${d.referenceAssetId}` : '素材资产 · 未设置'
      case 'blocks':
        return `分块描线 · ${d.blocks.length} 块`
    }
  }
</script>

{#if doc}
  <section
    class="flex min-h-0 flex-1 flex-col rounded-xl border bg-card"
    data-testid="designer-layers-panel"
    aria-label="图层面板"
    data-isolating={isolating}
  >
    <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 class="text-xs font-semibold tracking-tight">图层</h3>
      <Button
        variant="ghost"
        size="icon-xs"
        title="新建图层（⌘⇧N）"
        onclick={() => execDesignerCommand({ kind: 'new-layer' })}
        data-testid="designer-layer-new"
      >
        <Plus class="size-3.5" aria-hidden="true" />
        <span class="sr-only">新建图层</span>
      </Button>
    </header>

    <div class="grid content-start gap-1.5 overflow-y-auto px-2 py-2">
      <!-- 钻石层行（z 序倒排：上=最上） -->
      {#each layersReversed as layer (layer.id)}
        {@const isCurrent = layer.id === currentLayer}
        {@const mergeTargetName = mergeDownTargetName(layer)}
        {@const intakeTitle =
          intakeDisabled(layer)
            ? '移入选中钻（无选中钻 / 已全在该层 / 目标锁定或隐藏时不可用）'
            : `将 ${selectionCount} 颗选中钻移入「${layer.name}」`}
        <div
          class="grid gap-1 rounded-lg border px-2 py-1.5 {isCurrent ? 'border-primary/50 bg-primary/5' : 'border-transparent'}"
          data-testid={`designer-layer-row-${layer.id}`}
          data-current={isCurrent}
        >
          <div class="flex items-center gap-1">
            {#if renamingId === layer.id}
              <!-- 重命名（双击层名进入；Enter/失焦提交、Esc 取消） -->
              <input
                type="text"
                class="border-input bg-background h-6 min-w-0 flex-1 rounded border px-1.5 text-xs outline-none focus-visible:border-ring"
                bind:value={renameDraft}
                bind:this={renameInputEl}
                data-testid={`designer-layer-rename-input-${layer.id}`}
                aria-label="图层重命名"
                onkeydown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') cancelRename()
                }}
                onblur={() => commitRename()}
              />
            {:else}
              <button
                type="button"
                class="hover:bg-muted flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-medium"
                title={isCurrent ? '当前层（新钻/粘贴落点）；双击重命名' : '设为当前层；双击重命名'}
                onclick={() => selectLayer(layer.id)}
                ondblclick={() => beginRename(layer)}
                data-testid={`designer-layer-name-${layer.id}`}
              >
                <span class="truncate">{layer.name}</span>
                {#if isCurrent}
                  <span class="text-primary shrink-0 text-[10px] font-semibold">当前</span>
                {/if}
              </button>
            {/if}
            <button
              type="button"
              class="hover:bg-muted rounded p-1"
              title={layer.visible ? '隐藏图层（Alt+点击孤立显示）' : '显示图层（Alt+点击孤立显示）'}
              onclick={(e) => toggleLayerVisible(layer, e)}
              data-testid={`designer-layer-visible-${layer.id}`}
              aria-pressed={layer.visible}
            >
              {#if layer.visible}
                <Eye class="size-3.5" aria-hidden="true" />
              {:else}
                <EyeOff class="text-muted-foreground size-3.5" aria-hidden="true" />
              {/if}
              <span class="sr-only">{layer.visible ? '隐藏图层' : '显示图层'}</span>
            </button>
            <button
              type="button"
              class="hover:bg-muted rounded p-1"
              title={layer.locked ? '解锁图层' : '锁定图层（钻不可选中/编辑）'}
              onclick={() => setGemLayerLocked(layer.id, !layer.locked)}
              data-testid={`designer-layer-lock-${layer.id}`}
              aria-pressed={layer.locked}
            >
              {#if layer.locked}
                <Lock class="size-3.5" aria-hidden="true" />
              {:else}
                <LockOpen class="text-muted-foreground/60 size-3.5" aria-hidden="true" />
              {/if}
              <span class="sr-only">{layer.locked ? '解锁图层' : '锁定图层'}</span>
            </button>
          </div>
          <div class="flex items-center gap-0.5" role="group" aria-label="层操作">
            <!-- z 序上下移（数组序 op；拖排归 9.3 真浏览器走查） -->
            <Button
              variant="ghost"
              size="icon-xs"
              title="上移一层（z 序，⌘]）"
              onclick={() => moveLayer(layer.id, 1)}
              data-testid={`designer-layer-up-${layer.id}`}
            >
              <ChevronDown class="size-3 rotate-180" aria-hidden="true" />
              <span class="sr-only">上移一层</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="下移一层（z 序，⌘[）"
              onclick={() => moveLayer(layer.id, -1)}
              data-testid={`designer-layer-down-${layer.id}`}
            >
              <ChevronDown class="size-3" aria-hidden="true" />
              <span class="sr-only">下移一层</span>
            </Button>
            <!-- 向下合并（目标=下一可见未锁层；单 op；[6.1] ⌘E 同命令同目标解析） -->
            <Button
              variant="ghost"
              size="icon-xs"
              class="disabled:pointer-events-none disabled:opacity-40"
              title={
                mergeTargetName !== null
                  ? `向下合并：并入「${mergeTargetName}」（⌘E；层内钻随合并改写归属，单次撤销恢复）`
                  : '向下合并（下方无可见未锁层）'
              }
              disabled={mergeTargetName === null}
              onclick={() => mergeDown(layer)}
              data-testid={`designer-layer-merge-${layer.id}`}
            >
              <Merge class="size-3" aria-hidden="true" />
              <span class="sr-only">向下合并</span>
            </Button>
            <!-- 移入选中钻（单 op；禁用态按真实归属——吸取排钻移入 BUG 教训） -->
            <Button
              variant="ghost"
              size="icon-xs"
              class="disabled:pointer-events-none disabled:opacity-40"
              title={intakeTitle}
              disabled={intakeDisabled(layer)}
              onclick={() => intakeSelection(layer)}
              data-testid={`designer-layer-intake-${layer.id}`}
            >
              <Import class="size-3" aria-hidden="true" />
              <span class="sr-only">移入选中钻到此层</span>
            </Button>
            <span class="bg-border mx-0.5 h-3 w-px shrink-0" aria-hidden="true"></span>
            <button
              type="button"
              class="hover:bg-muted text-muted-foreground hover:text-destructive rounded p-1 disabled:pointer-events-none disabled:opacity-40"
              title={lastLayerGuard ? '最后剩余一层不可删（保底）' : '删除图层（含层内钻，需确认）'}
              disabled={lastLayerGuard}
              onclick={() => requestDeleteLayer(layer)}
              data-testid={`designer-layer-delete-${layer.id}`}
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
              <span class="sr-only">删除图层</span>
            </button>
          </div>
          <SliderField
            label="透明度"
            value={Math.round((layer.opacity ?? 1) * 100)}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onvaluechange={(v) => setGemLayerOpacity(layer.id, v / 100)}
          />
        </div>
      {/each}

      <!-- 参考底层钉底行（不可删/不可排序/无锁定——design §4.2 特殊层） -->
      {#if underlaySources.length > 0}
        <div class="mt-1 border-t pt-2">
          <div class="flex items-center gap-1" data-testid="designer-underlay-row">
            <button
              type="button"
              class="hover:bg-muted rounded p-0.5"
              onclick={() => (underlayExpanded = !underlayExpanded)}
              data-testid="designer-underlay-expand"
              aria-expanded={underlayExpanded}
              title="展开参考底层三源"
            >
              {#if underlayExpanded}
                <ChevronDown class="size-3.5" aria-hidden="true" />
              {:else}
                <ChevronRight class="size-3.5" aria-hidden="true" />
              {/if}
              <span class="sr-only">展开参考底层</span>
            </button>
            <span class="text-muted-foreground flex-1 px-1 text-xs font-medium">参考底层</span>
            <!-- 聚合眼睛 = 各源 visible 之 AND（派生）；点击 = 全开/全关 -->
            <button
              type="button"
              class="hover:bg-muted rounded p-1"
              title={underlayAllVisible ? '隐藏全部参考源' : '显示全部参考源'}
              onclick={toggleUnderlayAll}
              data-testid="designer-underlay-visible"
              aria-pressed={underlayAllVisible}
            >
              {#if underlayAllVisible}
                <Eye class="size-3.5" aria-hidden="true" />
              {:else}
                <EyeOff class="text-muted-foreground size-3.5" aria-hidden="true" />
              {/if}
              <span class="sr-only">{underlayAllVisible ? '隐藏全部参考源' : '显示全部参考源'}</span>
            </button>
          </div>
          {#if underlayExpanded}
            <div class="grid gap-1.5 pt-1.5" data-testid="designer-underlay-sources">
              {#each sourceOrder as key (key)}
                {@const source = underlaySources.find((s) => s.key === key)}
                {#if source}
                  <div class="grid gap-1 rounded-lg border border-dashed px-2 py-1.5" data-testid={`designer-underlay-source-${key}`}>
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        class="hover:bg-muted rounded p-1"
                        title={source.visible ? '隐藏该参考源' : '显示该参考源'}
                        onclick={() => setUnderlaySourceVisible(key, !source.visible)}
                        data-testid={`designer-underlay-source-visible-${key}`}
                        aria-pressed={source.visible}
                      >
                        {#if source.visible}
                          <Eye class="size-3.5" aria-hidden="true" />
                        {:else}
                          <EyeOff class="text-muted-foreground size-3.5" aria-hidden="true" />
                        {/if}
                        <span class="sr-only">{source.visible ? '隐藏该参考源' : '显示该参考源'}</span>
                      </button>
                      <span class="text-muted-foreground flex-1 text-xs">{SOURCE_LABELS[key]}</span>
                      <!-- 源展开详情（载荷摘要只读） -->
                      <button
                        type="button"
                        class="hover:bg-muted rounded p-0.5"
                        onclick={() => (expandedSources.has(key) ? expandedSources.delete(key) : expandedSources.add(key))}
                        data-testid={`designer-underlay-source-expand-${key}`}
                        aria-expanded={expandedSources.has(key)}
                        title="展开源详情"
                      >
                        {#if expandedSources.has(key)}
                          <ChevronDown class="size-3" aria-hidden="true" />
                        {:else}
                          <ChevronRight class="size-3" aria-hidden="true" />
                        {/if}
                        <span class="sr-only">展开源详情</span>
                      </button>
                    </div>
                    <SliderField
                      label="透明度"
                      value={Math.round(source.opacity * 100)}
                      min={0}
                      max={100}
                      step={5}
                      format={(v) => `${v}%`}
                      onvaluechange={(v) => setUnderlaySourceOpacity(key, v / 100)}
                    />
                    {#if expandedSources.has(key)}
                      <p class="text-muted-foreground/80 px-1 font-mono text-[10px]" data-testid={`designer-underlay-source-detail-${key}`}>
                        {sourceDetail(key)}
                      </p>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <!-- 删除层确认（全局纪律：删除=确认；含钻数说清后果） -->
  <ConfirmDialog
    open={deleteTarget !== null}
    title={deleteTarget !== null ? `删除图层「${deleteTarget.name}」？` : ''}
    description={
      deleteTargetGemCount > 0
        ? `该图层含 ${deleteTargetGemCount.toLocaleString()} 颗钻，将随图层一起删除。删除后可撤销。`
        : '该图层没有钻。删除后可撤销。'
    }
    confirmLabel="删除图层"
    onconfirm={confirmDeleteLayer}
    oncancel={() => (deleteTarget = null)}
    confirmTestId="designer-layer-delete-confirm"
    cancelTestId="designer-layer-delete-cancel"
  />
{/if}
