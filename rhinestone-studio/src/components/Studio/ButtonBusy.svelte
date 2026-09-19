<!--
[2026-09-19 Busy 原语] 按钮承载耗时状态（Owner 裁决：动作与 button 相关 → button 承载）：
busy = spinner 前置 + disabled + aria-busy；文案保留（不替换，用户意图始终可读）；
spinner 用固定尺寸 SVG（animate-spin 只转不变宽），不产生逐帧布局抖动。
放置决策：Studio 局部原语（src/components/Studio/），不进 src/lib/components/ui/——
该目录由 shadcn-svelte CLI 管理（components.json），自定义件会被后续 add/update 惊扰。
-->

<script lang="ts">
  import { Button, type ButtonProps } from '$lib/components/ui/button'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  let {
    busy = false,
    disabled = false,
    children,
    ...rest
  }: ButtonProps & { busy?: boolean } = $props()
</script>

<Button {...rest} disabled={disabled || busy} aria-busy={busy ? 'true' : undefined}>
  {#if busy}
    <LoaderCircle class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
  {/if}
  {@render children?.()}
</Button>
