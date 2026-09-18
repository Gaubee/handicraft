<!--
Orthogonal intents (max 3):
1. [2026-09-18 R3 PM-L2] 色板常驻只读 chips（色块+名称+用量，用量=当前导出策略 BOM 口径）；
     hex/name 增删改收进 Dialog（初始 setup 行为，日常只需看配色）。
2. [2026-09-18 R5 vision#14] 色板行合并输入：大 swatch（h-8 w-8 rounded-lg ring-inset）+ hex 单输入（# 前缀内嵌）。
3. [2026-09-18 气质] 钻点母题：swatch 即钻盘大色点。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import HelpTip from '../HelpTip.svelte'
  import {
    addColor,
    getBomSummary,
    getPalette,
    removeColor,
    upsertColor,
  } from '$lib/stores/studio.svelte'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  const palette = $derived(getPalette())
  const bom = $derived(getBomSummary())

  const usageOf = $derived.by(() => {
    const map = new Map<string, number>()
    for (const entry of bom) map.set(entry.id, entry.count)
    return (id: string) => map.get(id)
  })

  let editorOpen = $state(false)

  const HEX_RE = /^#[0-9a-fA-F]{6}$/

  function patchColor(id: string, patch: { name?: string; hex?: string }): void {
    const entry = palette.find((c) => c.id === id)
    if (!entry) return
    const name = patch.name !== undefined ? patch.name : entry.name
    const hex = patch.hex !== undefined ? patch.hex : entry.hex
    if (!HEX_RE.test(hex)) return
    upsertColor({ id, name: name.trim() || entry.name, hex: hex.toUpperCase() })
  }

  let draftName = $state('')
  let draftHex = $state('#')

  function handleAddColor(): void {
    if (!HEX_RE.test(draftHex)) return
    addColor(draftName, draftHex.toUpperCase())
    draftName = ''
    draftHex = '#'
  }
</script>

<div class="grid gap-2">
  <div class="flex flex-wrap gap-1.5" data-testid="palette-chips">
    {#each palette as entry (entry.id)}
      <span class="border-input inline-flex items-center gap-1.5 rounded-lg border bg-card px-1.5 py-1 text-xs">
        <span
          class="size-6 shrink-0 rounded-md ring-border ring-1 ring-inset"
          style="background: {entry.hex}"
          title={entry.hex}
        ></span>
        <span class="max-w-24 truncate">{entry.name}</span>
        {#if usageOf(entry.id) !== undefined}
          <span class="text-muted-foreground font-mono text-[10px] tabular-nums">×{usageOf(entry.id)}</span>
        {/if}
      </span>
    {/each}
  </div>
  <div class="flex items-center gap-2">
    <Button variant="outline" size="xs" onclick={() => (editorOpen = true)}>
      <Pencil />
      编辑色板
    </Button>
    <span class="text-muted-foreground flex items-center gap-1 text-xs">
      {palette.length} 色 · 用量 = 当前导出策略
      <HelpTip text="块代表色按 Lab ΔE 最近邻映射到色板；chips 上的用量是当前导出策略的 BOM 口径。增删改色在编辑弹窗里完成。" />
    </span>
  </div>
</div>

<Dialog.Root bind:open={editorOpen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-sm">编辑色板</Dialog.Title>
      <Dialog.Description class="text-xs">
        色名给采购看，hex 给映射用；条目 ID 稳定，删除会让引用它的颜色覆写失效。
      </Dialog.Description>
    </Dialog.Header>

    <div class="scrollbar-thin grid max-h-[50vh] gap-2 overflow-y-auto py-1">
      {#each palette as entry (entry.id)}
        <div class="flex items-center gap-2">
          <span
            class="size-8 shrink-0 rounded-lg ring-border ring-1 ring-inset"
            style="background: {entry.hex}"
            title={entry.hex}
          ></span>
          <Input
            class="h-8 flex-1 text-xs"
            value={entry.name}
            onchange={(e) => patchColor(entry.id, { name: e.currentTarget.value })}
            aria-label="色名"
          />
          <label class="relative block w-28 shrink-0">
            <span class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs">#</span>
            <Input
              class="h-8 pl-6 font-mono text-xs uppercase"
              value={entry.hex.replace(/^#/, '')}
              onchange={(e) => patchColor(entry.id, { hex: `#${e.currentTarget.value.replace(/^#/, '')}` })}
              aria-label="hex 色值"
            />
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-destructive w-8 shrink-0"
            disabled={palette.length <= 1}
            title="删除颜色"
            onclick={() => removeColor(entry.id)}
          >
            <Trash2 />
          </Button>
        </div>
      {/each}

      <div class="border-t pt-2">
        <div class="flex items-center gap-2">
          <span class="border-input size-8 shrink-0 rounded-lg border border-dashed"></span>
          <Input class="h-8 flex-1 text-xs" placeholder="新色名（如 深蓝）" bind:value={draftName} aria-label="新色名" />
          <label class="relative block w-28 shrink-0">
            <span class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs">#</span>
            <Input
              class="h-8 pl-6 font-mono text-xs uppercase"
              placeholder="RRGGBB"
              bind:value={draftHex}
              aria-label="新色 hex"
            />
          </label>
          <Button
            variant="secondary"
            size="icon-sm"
            class="w-8 shrink-0"
            disabled={!HEX_RE.test(draftHex)}
            title="添加颜色"
            onclick={handleAddColor}
          >
            <Plus />
          </Button>
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} size="sm">完成</Button>
        {/snippet}
      </Dialog.Close>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
