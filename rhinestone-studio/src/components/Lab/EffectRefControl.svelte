<!--
模板级「案例参照图」控制区（TemplateEditor 内嵌，[Owner 2026-09-19 参照对退役 + UI 简化裁决]；
[add-project-files 4.3] 绑定写回目标 = gemtpl.caseBinding（换绑保存））。
内嵌区只留两个元素：预览缩略（未绑定=虚线占位块，点击打开 Dialog）+ upload 图标按钮；
所有按钮与提示收进 Dialog（大图预览/绑定信息/上传两方案/粘贴链接/从素材库选/解绑）。
案例侧只绑定**一张**合成参照图；四入口：①原图+效果图（自动合成）②单张案例图
③粘贴链接（提交时即物化）④[从素材库选]（AssetPickerHost 选图器，caseLayout='single'）。
preset 过渡态语义已收窄到 seed 物化失败重试期（B.1.3）——本控件只消费 asset 绑定，
不再呈现「内置案例」kind。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { caseLayoutLabel, type CaseRefLayout } from '$lib/lab/caseComposite'
  import { describeDrillImageOrder } from '$lib/presets/effectRefs'
  import {
    getEffectRefCaseView,
    getReference,
    setTemplateEffectRefPair,
    setTemplateEffectRefSingle,
    setTemplateEffectRefUrls,
    type VariantEffectRef,
  } from '$lib/stores/lab.svelte'
  import { submitTemplateField } from '$lib/stores/templates.svelte'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import type { LabCaseBinding } from '$lib/persistence/labFile'
  import { showToast } from '$lib/stores/toast.svelte'
  import Link from '@lucide/svelte/icons/link'
  import Upload from '@lucide/svelte/icons/upload'
  import FolderOpen from '@lucide/svelte/icons/folder-open'

  let {
    templateAssetId,
    caseBinding,
  }: {
    templateAssetId: string
    caseBinding: LabCaseBinding | null
  } = $props()

  // 合成图展示视图：undefined = 解析中 / null = 失效（软删）
  let view = $state<{ url: string; caseLayout: CaseRefLayout; name?: string } | null | undefined>(undefined)
  // 参考原图（全局上传位）存在态 + 本模板附图序号（与请求提示词【图一/图二】同源计算）
  const reference = $derived(getReference())
  const imageOrder = $derived(
    describeDrillImageOrder({
      hasCase: view != null,
      caseLayout: view?.caseLayout ?? 'single',
      hasReference: !!reference,
    }),
  )
  const figureBadge = (role: 'case' | 'reference'): string | null => {
    const hit = imageOrder.find((e) => e.role === role)
    return hit ? `图${hit.figure}` : null
  }
  // 未上传参考图时的「预占」编号：按假设已上传重新求序（案例已绑定时是图二，否则图一）
  const projectedRefFigure = $derived(
    describeDrillImageOrder({
      hasCase: view != null,
      caseLayout: view?.caseLayout ?? 'single',
      hasReference: true,
    })
      .find((e) => e.role === 'reference')?.figure ?? '一',
  )
  $effect(() => {
    // caseBinding → asset 形态引用解析（getEffectRefCaseView 冻结出口）
    const ref: VariantEffectRef | null =
      caseBinding === null
        ? null
        : { kind: 'asset', assetId: caseBinding.assetId, caseLayout: caseBinding.caseLayout }
    let cancelled = false
    view = undefined
    if (ref) void getEffectRefCaseView(ref).then((v) => (cancelled ? undefined : (view = v)))
    return () => {
      cancelled = true
    }
  })

  // Dialog 开合（内嵌预览与图标按钮共用同一 Dialog）
  let dialogOpen = $state(false)

  // 粘贴链接折叠表单（提交时即物化）
  let urlFormOpen = $state(false)
  let srcUrlInput = $state('')
  let resUrlInput = $state('')

  // 方案①：原图可选、效果图选完即合成生效（双文件暂存配套）
  let pairSrcFile = $state<File | undefined>(undefined)
  let pairSrcInputEl: HTMLInputElement | null = null
  let pairResInputEl: HTMLInputElement | null = null
  let singleInputEl: HTMLInputElement | null = null

  // 物化中（canvas 合成 / fetch / 入库均为异步）：busy 态锁动作
  let busy = $state(false)

  const canSubmitUrl = $derived(resUrlInput.trim() !== '' && !busy)
  const layoutLabel = $derived(view ? caseLayoutLabel(view.caseLayout) : '')

  /** 物化结果反馈：合成降级（单张）时 toast 说明；错误 toast 由 catch 统一给出。 */
  function reportMaterialize(result: { degraded: boolean }): void {
    if (result.degraded) showToast('案例图自动合成不可用，已改用效果图单张作为案例参照')
  }

  async function applyUrls(): Promise<void> {
    const resUrl = resUrlInput.trim()
    if (!resUrl || busy) return
    const srcUrl = srcUrlInput.trim()
    busy = true
    try {
      const result = await setTemplateEffectRefUrls(templateAssetId, srcUrl || undefined, resUrl)
      reportMaterialize(result)
      urlFormOpen = false
      srcUrlInput = ''
      resUrlInput = ''
      dialogOpen = false
    } catch (error) {
      showToast(error instanceof Error ? error.message : '案例参照图绑定失败，请重试。')
    } finally {
      busy = false
    }
  }

  function handlePairSrc(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    pairSrcFile = input.files?.[0]
    input.value = '' // 允许重复选择同一文件
  }

  async function handlePairRes(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const res = input.files?.[0]
    input.value = ''
    if (!res || busy) return
    busy = true
    try {
      const result = await setTemplateEffectRefPair(templateAssetId, pairSrcFile, res)
      reportMaterialize(result)
      pairSrcFile = undefined
      dialogOpen = false
    } catch (error) {
      showToast(error instanceof Error ? error.message : '案例图上传失败，请重试。')
    } finally {
      busy = false
    }
  }

  async function handleSingle(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || busy) return
    busy = true
    try {
      await setTemplateEffectRefSingle(templateAssetId, file)
      dialogOpen = false
    } catch (error) {
      showToast(error instanceof Error ? error.message : '案例图上传失败，请重试。')
    } finally {
      busy = false
    }
  }

  /** 第四入口 [从素材库选]（B.1.3）：选库内任意图片作案例，绑定 {assetId, caseLayout:'single'}。 */
  async function pickFromLibrary(): Promise<void> {
    if (busy) return
    const picked = await assetPicker.open({ multi: false })
    if (!picked || picked.length === 0) return
    submitTemplateField(templateAssetId, {
      caseBinding: { assetId: picked[0].id, caseLayout: 'single' },
    })
    dialogOpen = false
  }

  function removeRef(): void {
    submitTemplateField(templateAssetId, { caseBinding: null })
    dialogOpen = false
  }
</script>

<div class="grid gap-1.5" data-testid="effect-ref-control">
  <!-- 内嵌区（Owner 简化裁决）：预览 + 打开按钮，两个元素 -->
  <div class="flex items-center gap-1.5">
    <button
      type="button"
      class="ring-ring/40 hover:ring-primary/40 relative flex h-14 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 transition-shadow"
      title={caseBinding ? '点击管理案例参照图' : '点击绑定案例参照图'}
      onclick={() => (dialogOpen = true)}
      data-testid="effect-ref-preview"
    >
      {#if view?.url}
        <img src={view.url} alt="案例参照合成图" class="size-full object-cover" draggable="false" />
        <span class="bg-foreground/80 text-background absolute bottom-0.5 left-0.5 rounded px-1 text-[10px] leading-4" data-testid="figure-badge-case">{figureBadge('case')}</span>
      {:else if caseBinding && view === null}
        <span class="text-muted-foreground text-[11px]">已失效</span>
      {:else if caseBinding}
        <span class="text-muted-foreground text-[11px]">加载中…</span>
      {:else}
        <span class="border-border text-muted-foreground flex size-full items-center justify-center rounded-md border border-dashed text-[11px]">+ 案例参照图</span>
      {/if}
      {#if busy}
        <span class="bg-background/60 text-foreground absolute inset-0 flex items-center justify-center text-[11px]" data-testid="effect-ref-busy">处理中…</span>
      {/if}
    </button>
    <Button
      variant="outline"
      size="icon-sm"
      title="管理案例参照图（上传 / 粘贴链接 / 从素材库选 / 解绑）"
      disabled={busy}
      onclick={() => (dialogOpen = true)}
      data-testid="effect-ref-open"
    >
      <Upload />
    </Button>
  </div>

  <!-- 参考图行（角标机制保留，不随案例区收进 Dialog） -->
  <div class="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="figure-order-reference">
    {#if reference}
      <span class="relative shrink-0">
        <img src={reference.previewUrl} alt="参考原图" class="size-8 rounded object-cover" draggable="false" />
        <span class="bg-primary text-primary-foreground absolute bottom-0 left-0 rounded px-1 text-[10px] leading-4">{figureBadge('reference')}</span>
      </span>
      <span>参考原图将以 <span class="text-foreground font-medium">图{imageOrder.find((e) => e.role === 'reference')?.figure}</span> 随本模板请求发送（目标图）</span>
    {:else}
      <span>上传参考原图后，将以 <span class="text-foreground font-medium">图{projectedRefFigure}</span> 随请求发送（当前未上传，不随附）</span>
    {/if}
  </div>

  <input
    type="file"
    accept="image/png,image/jpeg,image/webp"
    hidden
    bind:this={pairSrcInputEl}
    onchange={handlePairSrc}
    aria-label="案例原图（可选）"
  />
  <input
    type="file"
    accept="image/png,image/jpeg,image/webp"
    hidden
    bind:this={pairResInputEl}
    onchange={handlePairRes}
    aria-label="案例效果图（必填）"
  />
  <input
    type="file"
    accept="image/png,image/jpeg,image/webp"
    hidden
    bind:this={singleInputEl}
    onchange={handleSingle}
    aria-label="单张案例图"
  />

  <Dialog.Root bind:open={dialogOpen}>
    <Dialog.Content class="max-w-xl">
      <Dialog.Header>
        <Dialog.Title class="text-sm">案例参照图</Dialog.Title>
        <Dialog.Description>
          一张「原图 + 效果图」合成的参照图，随该模板的请求一起发送；也可从素材库直接选一张现成图片。
        </Dialog.Description>
      </Dialog.Header>

      <!-- 区块一：当前绑定预览 + 绑定信息 -->
      {#if view}
        <div class="grid gap-1.5">
          <img
            src={view.url}
            alt="案例参照合成图"
            class="max-h-[50vh] w-full rounded-lg border object-contain"
            draggable="false"
          />
          <div class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span>{layoutLabel}</span>
            {#if view.name}
              <span>· {view.name}</span>
            {/if}
          </div>
        </div>
      {:else if caseBinding}
        <p class="text-muted-foreground text-xs">案例参照图加载中或已失效。</p>
      {:else}
        <p class="text-muted-foreground text-xs leading-snug">
          该模板还未绑定案例参照图；也可不绑定，仅用提示词生成。
          {reference ? `参考原图当前以图${figureBadge('reference') ?? projectedRefFigure}随请求发送。` : `上传参考原图后将以图${projectedRefFigure}随请求发送。`}
        </p>
      {/if}

      <!-- 区块二：绑定动作（上传两方案 + 从素材库选 + 粘贴链接折叠表单） -->
      <div class="grid gap-2">
        <div class="flex flex-wrap items-center gap-1.5" data-testid="effect-ref-upload-pair">
          <Button variant="outline" size="xs" disabled={busy} onclick={() => pairSrcInputEl?.click()}>
            <Upload />
            选原图（可选）
          </Button>
          <Button variant="outline" size="xs" disabled={busy} onclick={() => pairResInputEl?.click()}>
            <Upload />
            上传原图+效果图（自动合成）
          </Button>
          {#if pairSrcFile}
            <span class="text-muted-foreground max-w-48 truncate text-[11px]" title={pairSrcFile.name}>原图：{pairSrcFile.name}</span>
          {/if}
          <span class="text-muted-foreground w-full text-[11px]">选效果图后自动合成为一张案例参照图（仅效果图时 = 单张）；PNG / JPEG / WebP，自动压缩到 2048px 内。</span>
        </div>

        <div data-testid="effect-ref-upload-single">
          <Button variant="outline" size="xs" disabled={busy} onclick={() => singleInputEl?.click()}>
            <Upload />
            上传单张案例图
          </Button>
        </div>

        <div data-testid="effect-ref-pick-library">
          <Button variant="outline" size="xs" disabled={busy} onclick={() => void pickFromLibrary()}>
            <FolderOpen />
            从素材库选
          </Button>
          <span class="text-muted-foreground ml-1.5 text-[11px]">选库内任意图片（含生成结果/案例）作为单张案例参照。</span>
        </div>

        <div class="grid gap-1.5" data-testid="effect-ref-url-form">
          {#if !urlFormOpen}
            <Button variant="outline" size="xs" class="justify-self-start" disabled={busy} onclick={() => (urlFormOpen = true)}>
              <Link />
              粘贴链接
            </Button>
          {:else}
            <div class="bg-muted/40 grid gap-1.5 rounded-lg p-2">
              <label class="grid gap-1 text-[11px]">
                <span class="text-muted-foreground">案例原图链接（可选）</span>
                <Input class="h-8 text-xs" placeholder="https://…/original.jpg" bind:value={srcUrlInput} disabled={busy} />
              </label>
              <label class="grid gap-1 text-[11px]">
                <span class="text-muted-foreground">贴钻效果图链接（必填）</span>
                <Input class="h-8 text-xs" placeholder="https://…/rhinestone.jpg" bind:value={resUrlInput} disabled={busy} />
              </label>
              <div class="flex flex-wrap items-center gap-1.5">
                <Button size="xs" disabled={!canSubmitUrl} onclick={() => void applyUrls()}>{busy ? '合成中…' : '确定'}</Button>
                <Button variant="ghost" size="xs" disabled={busy} onclick={() => (urlFormOpen = false)}>收起</Button>
                <span class="text-muted-foreground text-[11px]">提交时自动合成入库；需为可跨域读取的图片直链，否则请下载后上传</span>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- 区块三：解绑（有绑定时显示，底部次要位置） -->
      {#if caseBinding}
        <div class="border-t pt-2">
          <Button
            variant="ghost"
            size="xs"
            class="text-muted-foreground hover:text-destructive justify-self-start"
            disabled={busy}
            onclick={removeRef}
            data-testid="effect-ref-unbind"
          >
            解绑案例图（模板仍可纯提示词生成）
          </Button>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
</div>
