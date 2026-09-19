<!--
Orthogonal intents (max 1):
1. [2026-09-19 4.5 对比器] Dialog 职责收窄为参考图对比器（叠加/并排）：条目解析经 gallery store
   （GalleryEntry 并集——活卡 + 只读卡）；参考图来源 = 会话 reference ?? 条目 referenceAssetId
   （任务快照 / gemgen provenance）经 getAssetBlob 解析（刷新后/只读卡也能对比；
   两级不可得走既有「无参考图」分支）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import {
    downloadGalleryEntry,
    ensureEntryImageUrl,
    getGalleryEntry,
    getReadonlyImageUrl,
    resolveEntryReferenceUrl,
    whenGalleryUrlsIdle,
    type GalleryEntry,
  } from '$lib/stores/gallery.svelte'
  import Send from '@lucide/svelte/icons/send'
  import Download from '@lucide/svelte/icons/download'
  import Images from '@lucide/svelte/icons/images'
  import Blend from '@lucide/svelte/icons/blend'

  let {
    open = $bindable(false),
    entryKey = $bindable<string | null>(null),
    onsend,
  }: {
    open?: boolean
    entryKey?: string | null
    onsend: (entryKey: string) => void
  } = $props()

  let opacityValue = $state([1])
  let previewMode = $state<'overlay' | 'side'>('overlay')
  /** 参考图 objectURL（会话优先 ?? referenceAssetId 解析；null = 走「无参考图」分支）。 */
  let referenceUrl = $state<string | null>(null)
  let referencePending = $state(false)

  const entry = $derived(entryKey !== null ? getGalleryEntry(entryKey) : undefined)
  const task = $derived(entry?.live ? entry.task : undefined)

  // 打开时重置 + 解析参考图；条目变化（覆盖态翻转/画廊重扫）重解析（解析层有缓存，代价可控）。
  $effect(() => {
    if (!open) return
    opacityValue = [1]
    const current = entry
    referencePending = true
    let alive = true
    void resolveReferenceFor(current).then((url) => {
      if (!alive) return
      referenceUrl = url
      referencePending = false
      previewMode = url !== null ? 'overlay' : 'side'
    })
    return () => {
      alive = false
    }
  })

  /** 打开路径统一解析：先确保只读卡内嵌图懒解析启动，再解析参考图（会话 ?? referenceAssetId）。 */
  async function resolveReferenceFor(target: GalleryEntry | undefined): Promise<string | null> {
    if (target === undefined) return null
    ensureEntryImageUrl(target)
    await whenGalleryUrlsIdle()
    return resolveEntryReferenceUrl(target)
  }

  const readonlyUrl = $derived(
    entry !== undefined && !entry.live && entry.assetId !== undefined
      ? getReadonlyImageUrl(entry.assetId)
      : undefined,
  )
  const imageUrl = $derived(entry?.live ? task?.imageUrl : (readonlyUrl ?? undefined))
  const hasImage = $derived(imageUrl !== undefined && imageUrl !== null)
  const opacity = $derived(opacityValue[0] ?? 1)

  const checkerboard =
    'background-image: repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%); background-size: 16px 16px;'
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-4xl">
    <Dialog.Header>
      <Dialog.Title class="text-sm">
        {#if entry}
          {entry.templateName} · 候选 {entry.candidateIndex + 1}
          {#if !entry.live}
            <span class="text-muted-foreground font-normal">（库档案）</span>
          {:else if task?.durationMs !== undefined}
            <span class="text-muted-foreground font-normal">（{(task.durationMs / 1000).toFixed(1)}s）</span>
          {/if}
        {/if}
      </Dialog.Title>
      <Dialog.Description>叠加模式拖动透明度滑杆实时混合，用于判断风格化偏差；并排模式直接对比。</Dialog.Description>
    </Dialog.Header>

    {#if entry}
      <div class="grid gap-3">
        <Tabs.Root bind:value={previewMode}>
          <Tabs.List class="w-full">
            <Tabs.Trigger value="overlay" class="flex-1 gap-1.5" disabled={referenceUrl === null}>
              <Blend class="size-3.5" />
              叠加{referenceUrl === null ? '（无参考图）' : ''}
            </Tabs.Trigger>
            <Tabs.Trigger value="side" class="flex-1 gap-1.5">
              <Images class="size-3.5" />
              并排
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="overlay" class="mt-3">
            {#if referenceUrl !== null && hasImage}
              <div class="grid gap-3">
                <div class="relative mx-auto aspect-square w-full max-w-2xl overflow-hidden rounded-lg border" style={checkerboard}>
                  <img
                    src={referenceUrl}
                    alt="参考原图"
                    class="absolute inset-0 size-full object-contain"
                    draggable="false"
                  />
                  <img
                    src={imageUrl as string}
                    alt="生成候选"
                    class="absolute inset-0 size-full object-contain transition-opacity"
                    style="opacity: {opacity}"
                    draggable="false"
                  />
                </div>
                <label class="mx-auto flex w-full max-w-2xl items-center gap-3 text-xs">
                  <span class="text-muted-foreground w-20 shrink-0">候选不透明度</span>
                  <Slider type="multiple" bind:value={opacityValue} min={0} max={1} step={0.01} class="flex-1" />
                  <span class="text-muted-foreground w-10 shrink-0 text-right">{Math.round(opacity * 100)}%</span>
                </label>
              </div>
            {/if}
          </Tabs.Content>
          <Tabs.Content value="side" class="mt-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <figure class="grid gap-1">
                {#if referenceUrl !== null}
                  <div class="relative aspect-square overflow-hidden rounded-lg border" style={checkerboard}>
                    <img src={referenceUrl} alt="参考原图" class="absolute inset-0 size-full object-contain" draggable="false" />
                  </div>
                  <figcaption class="text-muted-foreground text-center text-xs">参考原图</figcaption>
                {:else if referencePending}
                  <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs">
                    参考图解析中…
                  </div>
                {:else}
                  <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs">
                    无参考原图
                  </div>
                {/if}
              </figure>
              <figure class="grid gap-1">
                {#if hasImage}
                  <div class="relative aspect-square overflow-hidden rounded-lg border" style={checkerboard}>
                    <img src={imageUrl as string} alt="生成候选" class="absolute inset-0 size-full object-contain" draggable="false" />
                  </div>
                  <figcaption class="text-muted-foreground text-center text-xs">生成候选</figcaption>
                {:else}
                  <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs">
                    {entry.parseError !== undefined ? '档案无法读取' : `该条目无图片（${entry.status}）`}
                  </div>
                {/if}
              </figure>
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <Dialog.Footer class="sm:justify-start">
        {#if hasImage && (entry.live ? entry.status === 'success' : entry.parseError === undefined)}
          <Button size="sm" onclick={() => onsend(entry.key)}>
            <Send />
            送转化
          </Button>
          <Button variant="outline" size="sm" onclick={() => void downloadGalleryEntry(entry.key)}>
            <Download class="size-4" />
            下载
          </Button>
        {/if}
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
