<!--
 * Orthogonal intents (max 1):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 图层面板区：现有四层显隐/透明度控件
 *    （原 EditView 浮层）迁入右侧栏槽位——图层化重写（studio-layers）前渲染语义不变。
 *    [2026-09-21 redesign-designer-workbench 1.1 v3 seam] 消费面随文档模型 v3 机械适配：
 *    钻石层行（doc.layers）+ underlay 源行（doc.underlay.sources）——DesignerLayersPanel
 *    重写（锁/重命名/拖排/新建删除）归切片 4，本组件不改结构与视觉。
-->

<script lang="ts">
  import SliderField from '../Studio/SliderField.svelte'
  import {
    getEditDoc,
    setGemLayerOpacity,
    setGemLayerVisible,
    setUnderlaySourceOpacity,
    setUnderlaySourceVisible,
    type UnderlaySourceKey,
  } from '$lib/stores/edit.svelte'

  const doc = $derived(getEditDoc())

  const UNDERLAY_LABELS: Record<UnderlaySourceKey, string> = {
    painting: '数字油画',
    reference: '原图',
    blocks: '分块描线',
  }
  /** 展示序 = 渲染序倒排（上 = 最上层：钻石层 z 序倒序 → blocks → reference → painting 钉底） */
  const underlayOrder: UnderlaySourceKey[] = ['blocks', 'reference', 'painting']
</script>

{#if doc}
  <section
    class="flex min-h-0 shrink-0 flex-col rounded-xl border bg-card"
    data-testid="edit-layers-panel"
    aria-label="图层面板"
  >
    <header class="border-b px-3 py-2">
      <h3 class="text-xs font-semibold tracking-tight">图层</h3>
    </header>
    <div class="grid gap-3 overflow-y-auto px-3 py-2.5">
      {#each [...doc.layers].reverse() as layer (layer.id)}
        <div class="grid gap-1.5">
          <label class="flex items-center gap-1.5 text-xs font-medium">
            <input
              type="checkbox"
              checked={layer.visible}
              onchange={(e) => setGemLayerVisible(layer.id, (e.currentTarget as HTMLInputElement).checked)}
              data-testid={`edit-layer-visible-${layer.id}`}
            />
            {layer.name}
          </label>
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
      {#each underlayOrder as key (key)}
        {#if doc.underlay.sources.some((s) => s.key === key)}
          {@const source = doc.underlay.sources.find((s) => s.key === key)!}
          <div class="grid gap-1.5">
            <label class="flex items-center gap-1.5 text-xs font-medium">
              <input
                type="checkbox"
                checked={source.visible}
                onchange={(e) => setUnderlaySourceVisible(key, (e.currentTarget as HTMLInputElement).checked)}
                data-testid={`edit-layer-visible-${key}`}
              />
              {UNDERLAY_LABELS[key]}
            </label>
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
  </section>
{/if}
