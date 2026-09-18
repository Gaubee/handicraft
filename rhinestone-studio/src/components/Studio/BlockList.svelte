<!--
Orthogonal intents (max 1):
1. [2026-09-18 R3] 块文字列表（画布为主选择器，本列表为无鼠标辅助）：行点击选中/再点取消，
     开关=禁用（不排钻）。上限高度内滚动，不与详情争屏。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Switch } from '$lib/components/ui/switch'
  import type { BlockType } from '$lib/engine'
  import {
    getBlocks,
    getColorOverride,
    getDisabledIds,
    getPalette,
    getSelectedBlockId,
    isEnabled,
    selectBlock,
    setEnabled,
  } from '$lib/stores/studio.svelte'

  const TYPE_LABELS: Record<BlockType, string> = { fill: '填充', linear: '线条', element: '元素' }

  const blocks = $derived(getBlocks())
  const selectedId = $derived(getSelectedBlockId())

  const palette = $derived(getPalette())

  function rgbCss(rgb: [number, number, number]): string {
    return `rgb(${rgb.map((v) => Math.round(v)).join(' ')})`
  }

  function colorOf(id: string): string | undefined {
    return palette.find((c) => c.id === id)?.hex
  }
</script>

{#if blocks.length === 0}
  <p class="text-muted-foreground px-1 text-xs">尚无分块（先载入数字油画）</p>
{:else}
  <div class="scrollbar-thin max-h-56 overflow-y-auto pr-1 lg:max-h-64">
    <div class="grid gap-1" data-testid="block-list">
      {#each blocks as b, i (b.id)}
        <div
          class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors
            {b.id === selectedId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            onclick={() => selectBlock(b.id === selectedId ? null : b.id)}
          >
            <span class="size-3.5 shrink-0 rounded-sm border" style="background: {rgbCss(b.colorRgb)}"></span>
            <span class="text-muted-foreground w-6 shrink-0 text-right font-mono text-[10px] tabular-nums">{i + 1}</span>
            <span class="flex-1 truncate">{b.label}</span>
            <Badge variant="outline" class="shrink-0 text-[10px]">{TYPE_LABELS[b.suggested]}</Badge>
            {#if getColorOverride(b.id) && colorOf(getColorOverride(b.id) ?? '')}
              <span
                class="size-2.5 shrink-0 rounded-full border"
                style="background: {colorOf(getColorOverride(b.id) ?? '')}"
                title="颜色覆写"
              ></span>
            {/if}
          </button>
          <Switch
            size="sm"
            checked={isEnabled(b.id)}
            onCheckedChange={(v) => setEnabled(b.id, v)}
            aria-label={isEnabled(b.id) ? `禁用 ${b.label}` : `启用 ${b.label}`}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}
