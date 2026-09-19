<!--
Orthogonal intents (max 2):
1. [2026-09-18 R2 PM-B1] 生成主行动条：sticky 吸底常驻；未配置 BYOK 时按钮变「配置连接」
     直开设置 Dialog（冷启动一步直达），startRun 校验保留为兜底；runError 内联到按钮旁（反馈不错位）。
2. [2026-09-18 计划数] plannedCount 与变体区摘要共享口径：×N 可核对（每个「变体×候选」= 一次请求）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import {
    cancelAll,
    getSettings,
    hasReference,
    isBusy,
    startRun,
  } from '$lib/stores/lab.svelte'
  import { getUsableTemplates } from '$lib/stores/templates.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Ban from '@lucide/svelte/icons/ban'
  import Settings2 from '@lucide/svelte/icons/settings-2'

  const settings = $derived(getSettings())

  let runError = $state('')

  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )
  // [4.3] 计划数口径与模板区摘要共享（templates store 的可用模板：启用 × 非空提示词 × 候选 ≥1）
  const plannedCount = $derived(getUsableTemplates().reduce((sum, t) => sum + t.candidates, 0))

  function handleRun(): void {
    runError = ''
    const result = startRun()
    if (!result.ok) runError = result.error ?? '发起失败'
  }
</script>

<div class="grid gap-2" data-testid="run-bar">
  {#if configured}
    <div class="flex items-center gap-2">
      <Button
        class="flex-1"
        onclick={handleRun}
        disabled={plannedCount === 0}
        data-testid="run-button"
      >
        <Sparkles />
        {hasReference() ? `开始生成（edits）× ${plannedCount}` : `开始生成（generations）× ${plannedCount}`}
      </Button>
      {#if isBusy()}
        <Button variant="outline" onclick={() => cancelAll()} title="取消全部进行中的任务">
          <Ban />
          取消全部
        </Button>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-1.5">
      <Button class="w-full" onclick={openSettings} data-testid="run-button">
        <Settings2 />
        配置连接
      </Button>
      <p class="text-muted-foreground text-center text-xs">
        尚未配置 Base URL / API Key / 模型 —— 完成配置后即可生成
      </p>
    </div>
  {/if}

  {#if runError}
    <p
      class="text-destructive rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
      data-testid="run-error"
      role="alert"
    >
      {runError}
    </p>
  {/if}
</div>
