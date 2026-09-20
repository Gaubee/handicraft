<!--
 * DesignerLayersPanel.svelte——图层面板骨架（design §1.2「右侧面板列·下图层」+ §4 图层系统）。
 *
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x（EditLayersPanel 固定四行退役重写）]
 *    参考底层钉底行（design §4.2：聚合眼睛=各源 visible 之 AND 派生、点击全开/全关；展开
 *    三源行——每源独立眼睛+透明度滑杆，R1-P0-3 源级显示态消费）+ 钻石层行列表（doc.layers
 *    z 序倒排展示：末位最上）。
 * 2. [2.x 骨架命令面] 层行：选当前层（新钻/智能排布落点真源 workbench.currentLayerIdOf）
 *    / 显隐 / 锁定 / 透明度 / z 序上下移（排序占位——拖排归 4.x）；面板命令：新建层 /
 *    删除层（ConfirmDialog 含钻数确认；末层保底；层内钻随层删——remove+layers 双 patch
 *    stroke 合组 = 单 undo）。合并/移入/Alt 孤立显示/双击重命名归 4.x。
 * 3. [Guard] 无文档整面板不渲染（消费面随 doc）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import SliderField from '../Studio/SliderField.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import {
    addGemLayer,
    applyPatch,
    beginStroke,
    endStroke,
    getEditDoc,
    setGemLayerLocked,
    setGemLayerOpacity,
    setGemLayerVisible,
    setUnderlaySourceOpacity,
    setUnderlaySourceVisible,
    type GemLayerRecord,
    type UnderlaySourceKey,
  } from '$lib/stores/edit.svelte'
  import {
    currentLayerIdOf,
    setCurrentLayerId,
  } from '$lib/designer/workbench.svelte'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Lock from '@lucide/svelte/icons/lock'
  import LockOpen from '@lucide/svelte/icons/lock-open'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'

  const doc = $derived(getEditDoc())
  /** 展示序 = 渲染序倒排（上 = 最上层：钻石层 z 序倒序 → 参考底层钉底）。 */
  const layersReversed = $derived(doc ? [...doc.layers].reverse() : [])
  const underlaySources = $derived(doc?.underlay.sources ?? [])
  /** 聚合眼睛 = 各源 visible 之 AND（派生态，不持久化——design §4.2）。 */
  const underlayAllVisible = $derived(underlaySources.length > 0 && underlaySources.every((s) => s.visible))
  const currentLayer = $derived(currentLayerIdOf(doc))

  let underlayExpanded = $state(false)

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

  /** z 序上下移（排序占位实现：数组序变更 op，单组可撤销——拖排归 4.x）。 */
  function moveLayer(id: string, dir: -1 | 1): void {
    const d = doc
    if (!d) return
    const i = d.layers.findIndex((l) => l.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= d.layers.length) return
    const next = d.layers.map((l) => ({ ...l }))
    const [moved] = next.splice(i, 1)
    next.splice(j, 0, moved)
    applyPatch({ op: 'layers', before: d.layers.map((l) => ({ ...l })), after: next })
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
</script>

{#if doc}
  <section
    class="flex min-h-0 flex-1 flex-col rounded-xl border bg-card"
    data-testid="designer-layers-panel"
    aria-label="图层面板"
  >
    <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 class="text-xs font-semibold tracking-tight">图层</h3>
      <Button
        variant="ghost"
        size="icon-xs"
        title="新建图层（⌘⇧N 归 6.x 键位）"
        onclick={() => addGemLayer()}
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
        <div
          class="grid gap-1 rounded-lg border px-2 py-1.5 {isCurrent ? 'border-primary/50 bg-primary/5' : 'border-transparent'}"
          data-testid={`designer-layer-row-${layer.id}`}
          data-current={isCurrent}
        >
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="hover:bg-muted flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-medium"
              title={isCurrent ? '当前层（新钻/智能排布落点）' : '设为当前层'}
              onclick={() => selectLayer(layer.id)}
              data-testid={`designer-layer-name-${layer.id}`}
            >
              <span class="truncate">{layer.name}</span>
              {#if isCurrent}
                <span class="text-primary shrink-0 text-[10px] font-semibold">当前</span>
              {/if}
            </button>
            <!-- 排序占位（上下移 = 数组序 op；拖排归 4.x） -->
            <div class="flex items-center" role="group" aria-label="层序">
              <Button
                variant="ghost"
                size="icon-xs"
                title="上移一层（z 序）"
                onclick={() => moveLayer(layer.id, 1)}
                data-testid={`designer-layer-up-${layer.id}`}
              >
                <ChevronDown class="size-3 rotate-180" aria-hidden="true" />
                <span class="sr-only">上移一层</span>
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="下移一层（z 序）"
                onclick={() => moveLayer(layer.id, -1)}
                data-testid={`designer-layer-down-${layer.id}`}
              >
                <ChevronDown class="size-3" aria-hidden="true" />
                <span class="sr-only">下移一层</span>
              </Button>
            </div>
            <button
              type="button"
              class="hover:bg-muted rounded p-1"
              title={layer.visible ? '隐藏图层' : '显示图层'}
              onclick={() => setGemLayerVisible(layer.id, !layer.visible)}
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
                      <span class="text-muted-foreground text-xs">{SOURCE_LABELS[key]}</span>
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
