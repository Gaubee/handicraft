<!--
Orthogonal intents (max 2):
1. [2026-09-18 R3 PM-L2] 分块参数（k/seed）：低频 + 重分块会清空块覆写 → 折叠收纳 + 破坏性警示。
2. [2026-09-18 R4 PM-4.4] 移动端只读降级：readOnly 时控件禁用并提示「桌面端调整」（查看保留）。
-->

<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import { Input } from '$lib/components/ui/input'
  import { getSegK, getSegSeed, setSegK, setSegSeed } from '$lib/stores/studio.svelte'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let { readOnly = false }: { readOnly?: boolean } = $props()
</script>

<div class="grid gap-2" class:pointer-events-none={readOnly} class:opacity-60={readOnly} data-disabled={readOnly || undefined}>
  <div class="grid grid-cols-2 gap-3">
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">颜色数 k</span>
      <Select.Root type="single" value={String(getSegK())} onValueChange={(v) => setSegK(Number(v))}>
        <Select.Trigger class="h-8 w-full text-xs"><Select.Value /></Select.Trigger>
        <Select.Content>
          {#each [6, 7, 8, 9, 10] as k (k)}
            <Select.Item value={String(k)} label={`${k} 色`} class="text-xs">{k} 色</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
    <label class="grid gap-1 text-xs">
      <span class="text-muted-foreground">种子 seed</span>
      <Input
        class="h-8 font-mono text-xs tabular-nums"
        type="number"
        min={0}
        value={getSegSeed()}
        onchange={(e) => setSegSeed(Number(e.currentTarget.value))}
      />
    </label>
  </div>
  {#if readOnly}
    <p class="text-muted-foreground flex items-center gap-1.5 text-xs">
      <TriangleAlert class="size-3.5 shrink-0" />
      重分块参数请在桌面端调整（调整会清空块覆写，误触代价高）
    </p>
  {:else}
    <p class="text-muted-foreground text-xs">
      调整后防抖重分块，<span class="text-foreground font-medium">已设置的块覆写会随旧块清空</span>。
    </p>
  {/if}
</div>
