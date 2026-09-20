<!--
 * Orthogonal intents (max 1):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 图层面板区：现有四层显隐/透明度控件
 *    （原 EditView 浮层）迁入右侧栏槽位——图层化重写（studio-layers）前渲染语义不变。
-->

<script lang="ts">
  import SliderField from '../Studio/SliderField.svelte'
  import { getEditDoc, setLayerOpacity, setLayerVisible, type EditLayerKey } from '$lib/stores/edit.svelte'

  const doc = $derived(getEditDoc())

  const LAYER_LABELS: Record<EditLayerKey, string> = {
    painting: '数字油画',
    reference: '原图',
    blocks: '分块描线',
    gems: '钻面',
  }
  const LAYER_ORDER: EditLayerKey[] = ['gems', 'blocks', 'reference', 'painting']
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
      {#each LAYER_ORDER as key (key)}
        <div class="grid gap-1.5">
          <label class="flex items-center gap-1.5 text-xs font-medium">
            <input
              type="checkbox"
              checked={doc.layers[key].visible}
              onchange={(e) => setLayerVisible(key, (e.currentTarget as HTMLInputElement).checked)}
              data-testid={`edit-layer-visible-${key}`}
            />
            {LAYER_LABELS[key]}
          </label>
          <SliderField
            label="透明度"
            value={Math.round(doc.layers[key].opacity * 100)}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onvaluechange={(v) => setLayerOpacity(key, v / 100)}
          />
        </div>
      {/each}
    </div>
  </section>
{/if}
