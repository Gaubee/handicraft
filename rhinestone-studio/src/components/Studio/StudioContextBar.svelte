<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 1.2] 上下文条（五区之一，h-10）：来源缩略/名称/尺寸 + 「更换」（[add-asset-library 5.1]
     经 AssetPickerController 选图换源，取消不动当前图）；移动端展开为来源行 + 参数抽屉入口行（现行为保留）。
2. [2026-09-19 Layout 拆装] 预览三模式 pills + 透明度 + 参考图上传（迁自 CompareGrid 区头，PM §3.2「保留交互，搬家」）；
     取景控制 适应/±/百分比（迁自 BlockCanvas 浮动工具栏，经 props 回调转发——BlockCanvas 零渲染改动）。
3. [2026-09-19 受控滑杆] 透明度 store ↔ 本地镜像（值未变不写守卫），防 bits-ui Slider 受控往返回路。
4. [2026-09-19 R4] 移动端抽屉入口（[块 N][物理][色板]）经 onOpenDrawer 回调上抛，抽屉本体仍在 StudioView（现行为）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import {
    getBlocks,
    getLoadError,
    getOverlayOpacity,
    getPainting,
    getPreviewMode,
    getReferenceImage,
    getSourceImage,
    loadFromLibrary,
    setOverlayOpacity,
    setPreviewMode,
    setReferenceFile,
    clearReferenceImage,
    type PreviewMode,
  } from '$lib/stores/studio.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import Layers from '@lucide/svelte/icons/layers'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minus from '@lucide/svelte/icons/minus'
  import Palette from '@lucide/svelte/icons/palette'
  import Plus from '@lucide/svelte/icons/plus'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Upload from '@lucide/svelte/icons/upload'

  interface Props {
    /** 移动端参数抽屉入口回调（抽屉本体与现行为留在 StudioView） */
    onOpenDrawer?: (kind: 'blocks' | 'physics' | 'palette') => void
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
  const mode = $derived(getPreviewMode())
  const reference = $derived(getReferenceImage())

  /** 缩略图：优先渲染已解码像素（离屏不可行时退回 dataUrl；测试直灌路径 dataUrl 为空则不显示） */
  const thumbUrl = $derived.by(() => {
    if (source?.dataUrl) return source.dataUrl
    return ''
  })

  const MODE_LABELS: Record<PreviewMode, string> = { gems: '纯钻', painting: '叠稿', reference: '叠原' }

  function onModeClick(next: PreviewMode): void {
    if (next === 'reference' && !reference) return
    setPreviewMode(next)
  }

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
    if (first) await loadFromLibrary({ id: first.id, name: first.name })
  }

  // 透明度滑杆本地镜像（store → 本地 → store，值未变不写守卫防受控振荡）
  let opacityValue = $state(0.5)
  $effect(() => {
    const next = getOverlayOpacity()
    if (next !== opacityValue) opacityValue = next
  })
</script>

<div
  class="bg-background/80 flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 backdrop-blur lg:h-10 lg:min-w-0 lg:flex-row lg:items-center lg:gap-3 lg:overflow-x-auto lg:py-0 lg:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  data-testid="context-bar"
>
  <!-- 来源组：缩略 + 名称 + 尺寸 + 更换（占位禁用）+ 载入错误；移动端此行右侧挂参数抽屉入口 -->
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

    <!-- 更换：素材库选图器（add-asset-library 5.1；controller 已就绪） -->
    <Button
      size="xs"
      variant="outline"
      onclick={() => void changeSource()}
      title="从素材库更换数字油画"
      data-testid="change-source"
    >
      更换
      <ChevronDown />
    </Button>

    {#if loadError}
      <span class="text-destructive truncate text-xs" role="alert">{loadError}</span>
    {/if}

    <!-- 移动端参数抽屉入口（现行为保留：ChevronUp 暗示可展开为底部抽屉） -->
    <div class="ml-auto flex shrink-0 items-center gap-1 py-1.5 lg:hidden" data-testid="mobile-param-entry">
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('blocks')}>
        <Layers />
        块 {blocks.length > 0 ? blocks.length : ''}
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('physics')}>
        <SlidersHorizontal />
        物理
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('palette')}>
        <Palette />
        色板
        <ChevronUp class="opacity-60" />
      </Button>
    </div>
  </div>

  <!-- 预览组（桌面）：三模式 pills + 参考图动作 + 透明度（迁自 CompareGrid） -->
  <div class="hidden items-center gap-2 lg:flex lg:min-w-0">
    <div class="flex shrink-0 items-center gap-1">
      {#each Object.entries(MODE_LABELS) as [m, label] (m)}
        <Button
          size="xs"
          variant={mode === m ? 'default' : 'secondary'}
          disabled={m === 'reference' && !reference}
          title={m === 'reference' && !reference ? '先上传/送转化带过参考原图' : `切换预览：${label}`}
          onclick={() => onModeClick(m as PreviewMode)}
          data-testid="preview-mode-{m}"
        >
          {label}
        </Button>
      {/each}
    </div>
    <label class="shrink-0 cursor-pointer">
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
    {#if mode !== 'gems'}
      <label class="flex min-w-36 flex-1 items-center gap-2 text-xs">
        <span class="text-muted-foreground shrink-0" title="底图不透明度">◐</span>
        <Slider
          type="single"
          bind:value={opacityValue}
          onValueChange={(v) => setOverlayOpacity(v ?? 0.5)}
          min={0}
          max={1}
          step={0.01}
          class="h-6 min-w-20 flex-1"
        />
        <span class="text-muted-foreground w-9 shrink-0 text-right font-mono text-[11px] tabular-nums">
          {Math.round(opacityValue * 100)}%
        </span>
      </label>
    {/if}
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
