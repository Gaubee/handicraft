<!--
Orthogonal intents (max 2):
1. [2026-09-18 R2] 原图卡：缩略图+尺寸+KB+edits 标注+移除；空态为虚线上传面（点击/拖拽）。
2. [2026-09-18 状态] 上传错误内联红字；降采样/请求路径说明收 HelpTip，不再铺灰字。
-->

<script lang="ts">
  import * as Card from '$lib/components/ui/card'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import HelpTip from '../HelpTip.svelte'
  import { clearReference, getReference, setReference } from '$lib/stores/lab.svelte'
  import ImagePlus from '@lucide/svelte/icons/image-plus'
  import X from '@lucide/svelte/icons/x'
  import Shrink from '@lucide/svelte/icons/shrink'

  let dragover = $state(false)
  let error = $state('')
  let fileInput = $state<HTMLInputElement | null>(null)

  const reference = getReference()

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    error = ''
    try {
      await setReference(files[0])
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    dragover = false
    void handleFiles(event.dataTransfer?.files ?? null)
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault()
    dragover = true
  }
</script>

<div class="grid gap-2">
  <input
    bind:this={fileInput}
    type="file"
    accept="image/png,image/jpeg,image/webp"
    class="hidden"
    onchange={(e) => {
      void handleFiles(e.currentTarget.files)
      e.currentTarget.value = ''
    }}
  />

  {#if reference}
    <Card.Root data-testid="reference-card">
      <Card.Content class="flex items-center gap-3 p-3">
        <img
          src={reference.previewUrl}
          alt="参考原图预览"
          class="size-16 shrink-0 rounded-md border object-contain"
          draggable="false"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-medium">{reference.file.name}</p>
          <p class="text-muted-foreground mt-0.5 font-mono text-xs tabular-nums">
            {#if reference.width > 0}
              {reference.width}×{reference.height}
            {:else}
              尺寸未知
            {/if}
            · {(reference.file.size / 1024).toFixed(0)} KB
          </p>
          <div class="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant="secondary" class="text-[10px]">走 /images/edits</Badge>
            {#if reference.downscaled}
              <Badge variant="outline" class="gap-0.5 text-[10px]">
                <Shrink class="size-3" />
                已降采样 ≤2048px
              </Badge>
            {/if}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-destructive"
          title="移除参考图"
          onclick={() => {
            clearReference()
          }}
        >
          <X />
        </Button>
      </Card.Content>
    </Card.Root>
  {:else}
    <button
      type="button"
      class="text-muted-foreground hover:border-ring hover:bg-muted/40 flex min-h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed bg-card p-4 text-xs transition-colors {dragover
        ? 'border-primary bg-primary/5'
        : ''}"
      onclick={() => fileInput?.click()}
      ondragover={onDragOver}
      ondragleave={() => (dragover = false)}
      ondrop={onDrop}
      data-testid="reference-dropzone"
    >
      <ImagePlus class="text-muted-foreground/50 size-7" />
      <span class="text-foreground font-medium">上传参考原图</span>
      <span>点击选择或拖拽 PNG / JPEG / WebP</span>
      <span class="text-muted-foreground/80">可选 · 超过 2048px 自动降采样</span>
    </button>
    <p class="text-muted-foreground flex items-center gap-1 text-xs">
      无参考图时走 /images/generations 纯文生图
      <HelpTip text="有参考图时请求走 /images/edits（在原图上重画）；无参考图走 /images/generations（纯文生图）。超过 2048px 的图会先降采样再上传。" />
    </p>
  {/if}

  {#if error}
    <p class="text-destructive text-xs" role="alert">{error}</p>
  {/if}
</div>
