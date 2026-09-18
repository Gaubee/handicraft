<!--
Orthogonal intents (max 1):
1. [2026-09-18 R3] 全局 toast 渲染：读 toast store，深底胶囊、自动消失由 store 负责。
     底部居中；移动端抬高避开底部 Tab Bar。
-->

<script lang="ts">
  import { dismissToast, getToasts } from '$lib/stores/toast.svelte'
  import CircleCheck from '@lucide/svelte/icons/circle-check'

  const toasts = $derived(getToasts())
</script>

<span data-toast-mark></span>
{#if toasts.length > 0}
  <div
    class="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2 lg:bottom-6"
    data-testid="toast-stack"
    role="status"
    aria-live="polite"
  >
    {#each toasts as toast (toast.id)}
      <button
        type="button"
        class="bg-foreground text-background pointer-events-auto flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium shadow-lg"
        onclick={() => dismissToast(toast.id)}
      >
        <CircleCheck class="size-4" />
        {toast.message}
      </button>
    {/each}
  </div>
{/if}
