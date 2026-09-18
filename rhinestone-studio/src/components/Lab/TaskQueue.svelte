<!--
Orthogonal intents (max 3):
1. [2026-09-18 R2] 画廊主体：分组骨架（变体名+候选数+延伸线）；候选 grid-cols-2 lg:grid-cols-3。
2. [2026-09-18 R2 PM] 空态=三步引导卡（①配置连接 ②传图(可选) ③开始生成），内嵌 CTA 一步直达；
     未配置时 CTA=配置连接（开设置），已配置时 CTA=开始生成（与 RunBar 同一动作）。
3. [2026-09-18 状态] 头行：N 张候选 + 生成中/排队徽标 + 清空历史（图标 ghost，去红色噪音）。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    clearHistory,
    getPendingCount,
    getRunningCount,
    getSettings,
    getTaskGroups,
    startRun,
  } from '$lib/stores/lab.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import TaskCard from './TaskCard.svelte'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import CircleCheck from '@lucide/svelte/icons/circle-check'

  let {
    onopenpreview,
    onsend,
  }: {
    onopenpreview: (taskId: string) => void
    onsend: (taskId: string) => void
  } = $props()

  const settings = $derived(getSettings())
  const groups = $derived(getTaskGroups())
  const running = $derived(getRunningCount())
  const pending = $derived(getPendingCount())
  const total = $derived(groups.reduce((sum, g) => sum + g.tasks.length, 0))

  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )

  /** 空态内嵌 CTA（vision #9）：与 RunBar 同一动作口径；发起失败就地提示 */
  let emptyRunError = $state('')

  function emptyStateRun(): void {
    emptyRunError = ''
    const result = startRun()
    if (!result.ok) emptyRunError = result.error ?? '发起失败'
  }
</script>

<div class="grid gap-4 content-start">
  <div class="flex items-center gap-2">
    <h2 class="text-sm font-semibold tracking-tight">任务画廊</h2>
    {#if total > 0}
      <Badge variant="secondary" class="font-mono tabular-nums">{total} 张候选</Badge>
    {/if}
    {#if running > 0 || pending > 0}
      <Badge class="font-mono tabular-nums">生成中 {running} · 排队 {pending}</Badge>
    {/if}
    {#if total > 0}
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-destructive ml-auto"
        title="清空历史"
        onclick={() => void clearHistory()}
      >
        <Trash2 />
      </Button>
    {/if}
  </div>

  {#if groups.length === 0}
    <Card.Root class="border-dashed bg-card/60" data-testid="gallery-empty">
      <Card.Content class="bg-gem-dots flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl p-6 text-center">
        <div class="grid w-full max-w-sm gap-2 text-left">
          {#each [{ n: 1, label: '配置连接（Base URL / API Key / 模型）', ok: configured }, { n: 2, label: '上传参考原图（可选，无图走纯文生图）', ok: false }] as step (step.n)}
            <div class="bg-background/85 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs backdrop-blur-xs">
              {#if step.ok}
                <CircleCheck class="text-primary size-4 shrink-0" />
              {:else}
                <span class="text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] tabular-nums">{step.n}</span>
              {/if}
              <span class={step.ok ? 'text-muted-foreground line-through' : ''}>{step.label}</span>
            </div>
          {/each}
          <div class="bg-background/85 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs backdrop-blur-xs">
            <span class="text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] tabular-nums">3</span>
            <span>点「开始生成」，候选会出现在这里</span>
          </div>
        </div>
        {#if configured}
          <Button size="sm" onclick={emptyStateRun} data-testid="empty-run-button">
            <Sparkles />
            开始生成
          </Button>
        {:else}
          <Button size="sm" onclick={openSettings} data-testid="empty-run-button">
            <Settings2 />
            配置连接
          </Button>
        {/if}
        {#if emptyRunError}
          <p class="text-destructive text-xs" role="alert">{emptyRunError}</p>
        {/if}
      </Card.Content>
    </Card.Root>
  {:else}
    {#each groups as group (group.variantId)}
      <section class="grid gap-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold tracking-wide">{group.variantName}</span>
          <span class="bg-border h-px flex-1"></span>
          <span class="text-muted-foreground font-mono text-[11px] tabular-nums">{group.tasks.length} 候选</span>
        </div>
        <div class="grid auto-rows-min grid-cols-2 gap-3 lg:grid-cols-3">
          {#each group.tasks as task (task.id)}
            <TaskCard {task} {onopenpreview} {onsend} />
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>
