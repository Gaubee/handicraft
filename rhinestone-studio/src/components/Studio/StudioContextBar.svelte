<!--
Orthogonal intents (max 3):
1. [2026-09-19 Layout 1.2 / 2026-09-20 studio-layers 2.7 瘦身] 上下文条：来源缩略/名称/尺寸 + 「更换」
     （素材库选图器）+ 参考原图管理 + 取景控制（适应/±/N%——经 props 转发，BlockCanvas 零渲染改动）。
     [2.5/2.7 废除] 预览三模式分段控件 + 全局透明度滑杆（收编背景层源/透明度——检查器背景面板）。
2. [2026-09-19 受控] 无本地状态镜像残留（透明度滑杆废除后本组件零受控滑杆）。
3. [2026-09-19 R4 / 2.7 移动端] 抽屉入口（图层/历史/检查器）经 onOpenDrawer 回调上抛，抽屉本体在
     StudioView（现行为）；载入错误常驻来源组。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import {
    clearReferenceImage,
    getBlocks,
    getLoadError,
    getPainting,
    getReferenceImage,
    getSourceImage,
    loadFromLibrary,
    setReferenceFile,
  } from '$lib/stores/studio.svelte'
  import ButtonBusy from './ButtonBusy.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import History from '@lucide/svelte/icons/history'
  import Layers from '@lucide/svelte/icons/layers'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Upload from '@lucide/svelte/icons/upload'

  interface Props {
    /** 移动端抽屉入口回调（抽屉本体与现行为留在 StudioView） */
    onOpenDrawer?: (kind: 'layers' | 'history' | 'inspector') => void
    /** 取景控制（迁自 BlockCanvas 浮动工具栏；由 StudioView 经 bind:this 转发到画布实例） */
    onFit?: () => void
    onZoomIn?: () => void
    onZoomOut?: () => void
    zoomPercent?: number | null
  }
  let { onOpenDrawer, onFit, onZoomIn, onZoomOut, zoomPercent = null }: Props = $props()

  const source = $derived(getSourceImage())
  const painting = $derived(getPainting())
  const loadError = $derived(getLoadError())
  const blocks = $derived(getBlocks())
  const reference = $derived(getReferenceImage())

  /** 缩略图：优先渲染已解码像素（离屏不可行时退回 dataUrl；测试直灌路径 dataUrl 为空则不显示） */
  const thumbUrl = $derived.by(() => {
    if (source?.dataUrl) return source.dataUrl
    return ''
  })

  async function onReferenceUpload(e: Event): Promise<void> {
    const input = e.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file) await setReferenceFile(file)
    input.value = ''
  }

  /** [5.1 更换] 素材库选图器换源（controller 单实例；取消/Esc 不动当前图）。 */
  async function changeSource(): Promise<void> {
    const picked = await assetPicker.open({ multi: false })
    const first = picked?.[0]
    if (!first) return
    // busy 只覆盖取图后的解码/入库/分块启动段（选图器浏览期间按钮背后不转圈）
    sourceBusy = true
    try {
      await loadFromLibrary({ id: first.id, name: first.name })
    } finally {
      sourceBusy = false
    }
  }

  // [2026-09-19 Busy] 更换 = button 承载：载入期间 spinner + disabled + aria-busy
  let sourceBusy = $state(false)
</script>

<div
  class="bg-background/80 flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 backdrop-blur lg:h-10 lg:min-w-0 lg:flex-row lg:items-center lg:gap-3 lg:overflow-x-auto lg:py-0 lg:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  data-testid="context-bar"
>
  <!-- 来源组：缩略 + 名称 + 尺寸 + 更换 + 参考原图管理 + 载入错误；移动端此行右侧挂抽屉入口 -->
  <div class="flex min-w-0 flex-1 items-center gap-2">
    {#if thumbUrl}
      <img
        src={thumbUrl}
        alt={source?.name ?? ''}
        class="border-input size-6 shrink-0 rounded border object-cover"
      />
    {:else}
      <span class="bg-gem-dots border-input size-6 shrink-0 rounded border" aria-hidden="true"></span>
    {/if}

    {#if source}
      <span class="min-w-0 max-w-40 truncate text-xs font-medium sm:max-w-48 lg:max-w-56" title={source.name}>{source.name}</span>
      <span class="text-muted-foreground hidden shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums sm:inline">
        {source.width}×{source.height}px{#if source.downscale < 1} · 已降采样 {(source.downscale * 100).toFixed(0)}%{/if}
      </span>
    {:else}
      <span class="text-muted-foreground truncate text-xs">未载入数字油画</span>
    {/if}

    <!-- 更换：素材库选图器；载入期间 button 承载 busy -->
    <ButtonBusy
      size="xs"
      variant="outline"
      busy={sourceBusy}
      onclick={() => void changeSource()}
      title="从素材库更换数字油画"
      data-testid="change-source"
    >
      更换
      <ChevronDown />
    </ButtonBusy>

    <!-- 参考原图管理（背景源=参考原图 的素材面——背景面板选择源，此处管理图片本体） -->
    <label class="hidden cursor-pointer lg:flex">
      <span
        class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium shadow-xs transition-colors"
      >
        <Upload class="size-3" />
        上传原图
      </span>
      <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={onReferenceUpload} />
    </label>
    {#if reference}
      <Button size="xs" variant="ghost" onclick={clearReferenceImage} title="移除参考原图">清除</Button>
    {/if}

    {#if loadError}
      <span class="text-destructive truncate text-xs" role="alert">{loadError}</span>
    {/if}

    <!-- 移动端抽屉入口（图层/历史/检查器——左列与检查器在移动端为 bottom sheet） -->
    <div class="ml-auto flex shrink-0 items-center gap-1 py-1.5 lg:hidden" data-testid="mobile-param-entry">
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('layers')}>
        <Layers />
        图层
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('history')}>
        <History />
        历史
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('inspector')}>
        <SlidersHorizontal />
        {blocks.length > 0 ? `检查器 · ${blocks.length} 块` : '检查器'}
        <ChevronUp class="opacity-60" />
      </Button>
    </div>
  </div>

  <!-- 取景组（桌面，迁自 BlockCanvas 浮动工具栏；移动端画布手势直达） -->
  {#if painting}
    <div class="hidden shrink-0 items-center gap-0.5 lg:flex">
      <span class="bg-border mx-1 h-5 w-px shrink-0" aria-hidden="true"></span>
      <Button size="icon-xs" variant="ghost" title="适应窗口（双击画布同效）" onclick={() => onFit?.()}>
        <Maximize />
      </Button>
      <Button size="icon-xs" variant="ghost" title="放大" onclick={() => onZoomIn?.()}>
        <Plus />
      </Button>
      <Button size="icon-xs" variant="ghost" title="缩小" onclick={() => onZoomOut?.()}>
        <Minus />
      </Button>
      <span class="text-muted-foreground px-1 font-mono text-xs tabular-nums" data-testid="canvas-zoom">
        {zoomPercent !== null ? `${zoomPercent}%` : '—'}
      </span>
    </div>
  {/if}
</div>
