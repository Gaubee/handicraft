<!--
Orthogonal intents (max 3):
1. [2026-09-19 Shell] 手动编辑视图空壳（add-manual-edit-mode tasks 3.x/4.x 本波范围）：
   载入后 = 顶栏摘要（钻数/来源 sourceSummary/未导出修改徽标）+ 只读四层画布；
   工具栏/笔刷/撤销重做 UI 属下一波（tasks 5.x）。
2. [2026-09-19 Lifecycle] 刷新/无 handoff 进入 → 空态引导回工作台「送精修」（编辑文档唯一入口）。
3. [2026-09-19 Layers] 固定四层显隐/透明度的轻量入口（右侧浮层开关 + 透明度滑杆，
   仅渲染语义——颜色过滤/编辑过滤不改归属与导出，见 design.md §3）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import EditCanvas from '../../../components/Edit/EditCanvas.svelte'
  import SliderField from '../../../components/Studio/SliderField.svelte'
  import { setView } from '$lib/stores/view.svelte'
  import {
    getEditDoc,
    hasEdits,
    setLayerOpacity,
    setLayerVisible,
    type EditLayerKey,
  } from '$lib/stores/edit.svelte'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'

  const doc = $derived(getEditDoc())
  const edited = $derived(hasEdits())

  const LAYER_LABELS: Record<EditLayerKey, string> = {
    painting: '数字油画',
    reference: '参考原图',
    blocks: '分块描线',
    gems: '钻面',
  }
  const LAYER_ORDER: EditLayerKey[] = ['gems', 'blocks', 'reference', 'painting']

  let layersPanelOpen = $state(false)
</script>

{#if doc}
  <div class="flex h-full min-h-0 flex-col gap-3 p-3 lg:p-4">
    <!-- 顶栏摘要：钻数（大数字）+ 来源 + 修改徽标 -->
    <header class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" data-testid="edit-summary">
      <span class="font-mono text-base font-semibold tabular-nums" data-testid="edit-gem-count">
        {doc.gems.length.toLocaleString()}
        <span class="text-muted-foreground text-xs font-normal">钻</span>
      </span>
      <span class="text-muted-foreground" data-testid="edit-source-summary">{doc.sourceSummary}</span>
      <span class="text-muted-foreground hidden font-mono text-[10px] sm:inline">
        {doc.width}×{doc.height}px
      </span>
      {#if edited}
        <Badge variant="secondary" data-testid="edit-dirty-badge">有未导出修改</Badge>
      {/if}
      <Button
        variant="ghost"
        size="xs"
        class="ml-auto"
        onclick={() => (layersPanelOpen = !layersPanelOpen)}
        data-testid="edit-layers-toggle"
      >
        图层
      </Button>
    </header>

    <div class="relative min-h-0 flex-1">
      <EditCanvas />

      <!-- 图层浮层：显隐 + 透明度（固定四层，渲染语义） -->
      {#if layersPanelOpen}
        <div
          class="absolute right-3 top-3 z-20 w-56 rounded-lg border bg-background/90 p-3 shadow-md backdrop-blur"
          data-testid="edit-layers-panel"
        >
          <div class="grid gap-3">
            {#each LAYER_ORDER as key (key)}
              <div class="grid gap-1.5">
                <label class="flex items-center gap-1.5 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={doc.layers[key].visible}
                    onchange={(e) =>
                      setLayerVisible(key, (e.currentTarget as HTMLInputElement).checked)}
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
        </div>
      {/if}
    </div>
  </div>
{:else}
  <!-- 空态：无交接快照（刷新/直接进入）——唯一入口是工作台「送精修」 -->
  <div
    class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center"
    data-testid="edit-empty"
  >
    <div class="flex flex-col items-center gap-1.5">
      <h3 class="text-sm font-semibold tracking-tight">还没有送入精修的图</h3>
      <p class="text-muted-foreground text-xs">
        手动编辑以工作台的烘焙快照为起点——先在工作台调好参数，再点「送精修」进入这里
      </p>
    </div>
    <Button onclick={() => setView('studio')} data-testid="edit-empty-goto-studio">
      <ArrowLeft />
      回工作台送精修
    </Button>
  </div>
{/if}
