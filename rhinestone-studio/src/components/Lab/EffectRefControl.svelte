<!--
变体级「效果参考」控制区（VariantEditor 展开态内嵌）。
三种来源：案例库（preset）/ 粘贴链接（url）/ 上传图片（upload）。
有参考时展示「原图 → 贴钻效果」并排缩略图 + 来源徽章 + 移除；
无参考时一行三个入口按钮（移动端 flex-wrap）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'
  import {
    getEffectRefUrls,
    setVariantEffectRefUpload,
    updateVariant,
    type VariantEffectRef,
  } from '$lib/stores/lab.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Library from '@lucide/svelte/icons/library'
  import Link from '@lucide/svelte/icons/link'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'

  let {
    variantId,
    effectRef,
  }: {
    variantId: string
    effectRef: VariantEffectRef | null | undefined
  } = $props()

  // 展示 URL：preset → 静态路径 / url → 直链 / upload → IDB objectURL（异步）
  let urls = $state<{ srcUrl: string; resUrl: string } | null>(null)
  $effect(() => {
    const ref = effectRef
    let cancelled = false
    urls = null
    if (ref) void getEffectRefUrls(ref).then((u) => (cancelled ? undefined : (urls = u)))
    return () => {
      cancelled = true
    }
  })

  // 入口与弹层开合
  let presetOpen = $state(false)
  let urlFormOpen = $state(false)
  let uploadOpen = $state(false)
  let compareOpen = $state(false)

  // 粘贴链接表单
  let srcUrlInput = $state('')
  let resUrlInput = $state('')

  // 上传：效果图选完即生效，原图可选（暂存待配套）
  let uploadBusy = $state(false)
  let uploadSrcFile = $state<File | undefined>(undefined)
  let srcInputEl: HTMLInputElement | null = null
  let resInputEl: HTMLInputElement | null = null

  const kindLabel = $derived(
    effectRef?.kind === 'preset' ? '案例库' : effectRef?.kind === 'url' ? '链接' : effectRef?.kind === 'upload' ? '上传' : '',
  )
  const preset = $derived(
    effectRef?.kind === 'preset' ? EFFECT_REF_PRESETS.find((p) => p.id === effectRef.presetId) : undefined,
  )
  const canSubmitUrl = $derived(resUrlInput.trim() !== '')

  function applyPreset(id: string): void {
    updateVariant(variantId, { effectRef: { kind: 'preset', presetId: id } })
    presetOpen = false
  }

  function applyUrl(): void {
    const resUrl = resUrlInput.trim()
    if (!resUrl) return
    const srcUrl = srcUrlInput.trim()
    updateVariant(variantId, { effectRef: { kind: 'url', srcUrl: srcUrl || undefined, resUrl } })
    urlFormOpen = false
  }

  function handleUploadSrc(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    uploadSrcFile = input.files?.[0]
    input.value = '' // 允许重复选择同一文件
  }

  async function handleUploadRes(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const res = input.files?.[0]
    input.value = ''
    if (!res) return
    uploadBusy = true
    try {
      await setVariantEffectRefUpload(variantId, uploadSrcFile, res)
      uploadSrcFile = undefined
      uploadOpen = false
    } catch (error) {
      showToast(error instanceof Error ? error.message : '效果参考上传失败，请重试。')
    } finally {
      uploadBusy = false
    }
  }

  function removeRef(): void {
    updateVariant(variantId, { effectRef: null })
  }
</script>

<div class="grid gap-1.5" data-testid="effect-ref-control">
  <div class="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
    <span class="text-foreground font-medium">效果参考</span>
    <span>「原图 → 贴钻效果」参考对，随该变体的请求一起发送</span>
  </div>

  {#if effectRef}
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="ring-ring/40 hover:ring-primary/40 flex items-center gap-1.5 rounded-md p-0.5 ring-1 transition-shadow"
        title="点击放大对比"
        onclick={() => (compareOpen = true)}
        data-testid="effect-ref-pair"
      >
        {#if urls === null}
          <span class="text-muted-foreground flex h-14 w-28 items-center justify-center text-[11px]">加载中…</span>
        {:else}
          {#if urls.srcUrl}
            <img src={urls.srcUrl} alt="效果参考原图" class="size-14 rounded-md object-cover" draggable="false" />
            <ArrowRight class="text-muted-foreground size-3.5 shrink-0" />
          {/if}
          <img src={urls.resUrl} alt="贴钻效果参考" class="size-14 rounded-md object-cover" draggable="false" />
        {/if}
      </button>
      <Badge variant="secondary" class="text-[10px]">{kindLabel}</Badge>
      {#if preset}
        <span class="text-muted-foreground max-w-40 truncate text-[11px]" title={preset.summary}>{preset.name}</span>
      {/if}
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-destructive"
        title="移除效果参考"
        onclick={removeRef}
        data-testid="effect-ref-remove"
      >
        <X />
      </Button>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-1.5" data-testid="effect-ref-entries">
      <Button variant="outline" size="xs" onclick={() => (presetOpen = true)}>
        <Library />
        案例库
      </Button>
      <Button variant="outline" size="xs" onclick={() => (urlFormOpen = !urlFormOpen)}>
        <Link />
        粘贴链接
      </Button>
      <Button variant="outline" size="xs" onclick={() => (uploadOpen = !uploadOpen)}>
        <Upload />
        上传图片
      </Button>
    </div>

    {#if urlFormOpen}
      <div class="bg-muted/40 grid gap-1.5 rounded-lg p-2" data-testid="effect-ref-url-form">
        <label class="grid gap-1 text-[11px]">
          <span class="text-muted-foreground">效果原图链接（可选）</span>
          <Input class="h-8 text-xs" placeholder="https://…/original.jpg" bind:value={srcUrlInput} />
        </label>
        <label class="grid gap-1 text-[11px]">
          <span class="text-muted-foreground">贴钻效果图链接（必填）</span>
          <Input class="h-8 text-xs" placeholder="https://…/rhinestone.jpg" bind:value={resUrlInput} />
        </label>
        <div class="flex flex-wrap items-center gap-1.5">
          <Button size="xs" disabled={!canSubmitUrl} onclick={applyUrl}>确定</Button>
          <span class="text-muted-foreground text-[11px]">需为可跨域读取的图片直链，否则请下载后上传</span>
        </div>
      </div>
    {/if}

    {#if uploadOpen}
      <div class="bg-muted/40 grid gap-1.5 rounded-lg p-2" data-testid="effect-ref-upload-form">
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Button variant="outline" size="xs" disabled={uploadBusy} onclick={() => srcInputEl?.click()}>
            <Upload />
            选原图（可选）
          </Button>
          <Button variant="outline" size="xs" disabled={uploadBusy} onclick={() => resInputEl?.click()}>
            <Upload />
            选效果图（必填）
          </Button>
          {#if uploadSrcFile}
            <span class="text-muted-foreground max-w-48 truncate" title={uploadSrcFile.name}>原图：{uploadSrcFile.name}</span>
          {/if}
        </div>
        <span class="text-muted-foreground text-[11px]">选择效果图后立即生效；支持 PNG / JPEG / WebP，自动压缩到 2048px 内。</span>
      </div>
    {/if}
  {/if}

  <input
    type="file"
    accept="image/png,image/jpeg,image/webp"
    hidden
    bind:this={srcInputEl}
    onchange={handleUploadSrc}
    aria-label="效果参考原图（可选）"
  />
  <input
    type="file"
    accept="image/png,image/jpeg,image/webp"
    hidden
    bind:this={resInputEl}
    onchange={handleUploadRes}
    aria-label="效果参考效果图（必填）"
  />

  <Dialog.Root bind:open={presetOpen}>
    <Dialog.Content class="max-w-2xl">
      <Dialog.Header>
        <Dialog.Title class="text-sm">效果参考案例库</Dialog.Title>
        <Dialog.Description>选择一对「原图 → 贴钻效果」参考；选中即挂到当前变体。</Dialog.Description>
      </Dialog.Header>
      <div class="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {#each EFFECT_REF_PRESETS as presetItem (presetItem.id)}
          <button
            type="button"
            class="ring-ring/40 hover:ring-primary/50 grid gap-1.5 rounded-lg p-2 text-left ring-1 transition-shadow"
            title={presetItem.sourceNote}
            data-testid="effect-ref-preset-{presetItem.id}"
            onclick={() => applyPreset(presetItem.id)}
          >
            <span class="flex items-center gap-1.5">
              {#if presetItem.srcImage}
                <img src={presetItem.srcImage} alt={`${presetItem.name} 原图`} class="h-20 w-20 rounded-md object-cover" draggable="false" />
                <ArrowRight class="text-muted-foreground size-3.5 shrink-0" />
              {/if}
              <img src={presetItem.resImage} alt={`${presetItem.name} 贴钻效果`} class="h-20 w-20 rounded-md object-cover" draggable="false" />
            </span>
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="text-xs font-medium">{presetItem.name}</span>
              <Badge variant="outline" class="text-[10px]">{presetItem.sourceNote}</Badge>
            </span>
            <span class="text-muted-foreground line-clamp-2 text-[11px] leading-snug">{presetItem.summary}</span>
          </button>
        {/each}
      </div>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={compareOpen}>
    <Dialog.Content class="max-w-2xl">
      <Dialog.Header>
        <Dialog.Title class="text-sm">效果参考 · 原图 → 贴钻效果</Dialog.Title>
        <Dialog.Description>{preset ? `${preset.name}（${preset.sourceNote}）` : `来源：${kindLabel}`}</Dialog.Description>
      </Dialog.Header>
      {#if urls}
        <div class="flex flex-wrap items-center justify-center gap-3">
          {#if urls.srcUrl}
            <figure class="grid gap-1">
              <img src={urls.srcUrl} alt="效果参考原图" class="w-64 max-w-full rounded-lg border object-contain" draggable="false" />
              <figcaption class="text-muted-foreground text-center text-xs">原图</figcaption>
            </figure>
            <ArrowRight class="text-muted-foreground size-5 shrink-0" />
          {/if}
          <figure class="grid gap-1">
            <img src={urls.resUrl} alt="贴钻效果参考" class="w-64 max-w-full rounded-lg border object-contain" draggable="false" />
            <figcaption class="text-muted-foreground text-center text-xs">贴钻效果</figcaption>
          </figure>
        </div>
      {:else}
        <p class="text-muted-foreground text-xs">参考图加载中或已失效。</p>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
</div>
