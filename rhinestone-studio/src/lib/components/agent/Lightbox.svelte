<!--
  应用内图片 Lightbox（T4 2026-10-01 Owner 细节批：附件 chip 不再直跳新窗口——
  应用内看图 + 缩放/平移，新窗口开原图只作保底入口）：
  - 图片区：滚轮缩放（0.25–4x，中心缩放简化）+ ±按钮分档、pointer 拖拽平移、
    双击复位 1x；切图/复位联动（切图重置缩放与平移）。
  - 底部信息条：{name} · {当前/总数} + 「新窗口打开」次钮（assetRawUrl 原图
    target=_blank——保底看原尺寸）+ 缩放百分比。
  - 关闭：top-inline-end X 钮 / Esc / 点击背景（图片本体不关——与拖拽/双击冲突；
    舞台层 pointer-events-none，img 自身 pointer-events-auto 透传实现）。
  - 切图：左右箭头 + 键盘 ←/→（循环）；单图隐藏箭头。
  - 401 自愈：img onerror 挂 retryRawImageOnError（daemon 重启 token 轮换场景）。
-->
<script lang="ts">
  import IconChevronLeft from '@lucide/svelte/icons/chevron-left'
  import IconChevronRight from '@lucide/svelte/icons/chevron-right'
  import IconExternalLink from '@lucide/svelte/icons/external-link'
  import IconMinus from '@lucide/svelte/icons/minus'
  import IconPlus from '@lucide/svelte/icons/plus'
  import IconX from '@lucide/svelte/icons/x'
  import { assetRawUrl, retryRawImageOnError } from '$lib/agentApi/attachments'

  let {
    items,
    index,
    onclose,
  }: {
    /** 会话内全部附件图（当前气泡的 attachments——Lightbox 内可左右切全组）。 */
    items: Array<{ blobRef: string; name: string }>
    /** 打开时的起始图序（导航为组件内部态——切图不回写父层）。 */
    index: number
    onclose: () => void
  } = $props()

  const ZOOM_MIN = 0.25
  const ZOOM_MAX = 4
  /** ±按钮/滚轮分档倍率（×1.25/×1.1——按钮粗档、滚轮细档）。 */
  const clampZoom = (value: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))

  // 初值语义（有意为之）：打开时从 props 定起始位，此后导航/缩放均为组件
  // 内部态——父层不回写、props 变更不重置（会话内 items 静态）。
  // svelte-ignore state_referenced_locally
  let current = $state(Math.min(Math.max(index, 0), items.length - 1))
  let zoom = $state(1)
  let tx = $state(0)
  let ty = $state(0)

  function resetView(): void {
    zoom = 1
    tx = 0
    ty = 0
  }

  function step(delta: number): void {
    if (items.length < 2) return
    current = (current + delta + items.length) % items.length
    resetView()
  }

  function zoomBy(factor: number): void {
    zoom = clampZoom(zoom * factor)
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault() // 缩放优先于背后转录流的页面滚动
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1)
  }

  // 拖拽平移（pointer capture——移出窗口不断线；仅位移不改缩放）。
  let dragging = $state(false)
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY, tx, ty }
    target.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    tx = dragStart.tx + (event.clientX - dragStart.x)
    ty = dragStart.ty + (event.clientY - dragStart.y)
  }

  function onPointerUp(): void {
    dragging = false
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      onclose()
      return
    }
    if (event.key === 'ArrowLeft') step(-1)
    else if (event.key === 'ArrowRight') step(1)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- 背景点击关闭：舞台层 pointer-events-none，点击穿透到本层；图片/控件自身
     stopPropagation（图片点击不关——拖拽冲突）。键盘等价关闭=Esc（svelte:window）。
     注：图片交互面用 <button> 承载——$state 响应式 {#if} 分支下 img 直挂交互
     事件时 svelte-ignore 注释失效（Svelte 5.57 编译器缺陷，实证探针定位），
     button 形态语义等价（拖拽平移/滚轮缩放/双击复位）且无警告。 -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="bg-black/80 fixed inset-0 z-50 flex flex-col backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-label="图片查看器"
  tabindex="-1"
  data-testid="lightbox"
  onclick={() => onclose()}
>
  <!-- 图片区（flex-1 舞台 + 浮动控件层）。 -->
  <div class="relative min-h-0 flex-1">
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      {#if items[current] !== undefined}
        <button
          type="button"
          class="pointer-events-auto flex touch-none border-0 bg-transparent p-0 {dragging ? 'cursor-grabbing' : 'cursor-grab'}"
          aria-label="图片查看区（拖拽平移，滚轮缩放，双击复位）"
          onclick={(event) => event.stopPropagation()}
          ondblclick={(event) => {
            event.stopPropagation()
            resetView()
          }}
          onwheel={onWheel}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          data-testid="lightbox-stage"
        >
          <img
            src={assetRawUrl(items[current].blobRef)}
            alt={items[current].name}
            draggable="false"
            class="max-h-full max-w-full select-none"
            style="transform: translate({tx}px, {ty}px) scale({zoom})"
            onerror={retryRawImageOnError}
            data-testid="lightbox-image"
          />
        </button>
      {/if}
    </div>

    <!-- top-inline-end 关闭钮。 -->
    <button
      type="button"
      class="text-muted-foreground hover:bg-white/10 hover:text-foreground absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-black/40 transition-colors"
      title="关闭（Esc）"
      aria-label="关闭图片查看器"
      onclick={(event) => {
        event.stopPropagation()
        onclose()
      }}
      data-testid="lightbox-close"
    >
      <IconX class="size-4" aria-hidden="true" />
    </button>

    <!-- 左右切图箭头（单图隐藏）。 -->
    {#if items.length > 1}
      <button
        type="button"
        class="text-muted-foreground hover:bg-white/10 hover:text-foreground absolute top-1/2 left-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 transition-colors"
        title="上一张（←）"
        aria-label="上一张图片"
        onclick={(event) => {
          event.stopPropagation()
          step(-1)
        }}
        data-testid="lightbox-prev"
      >
        <IconChevronLeft class="size-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="text-muted-foreground hover:bg-white/10 hover:text-foreground absolute top-1/2 right-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 transition-colors"
        title="下一张（→）"
        aria-label="下一张图片"
        onclick={(event) => {
          event.stopPropagation()
          step(1)
        }}
        data-testid="lightbox-next"
      >
        <IconChevronRight class="size-5" aria-hidden="true" />
      </button>
    {/if}

    <!-- ±缩放按钮（图片区右下浮动竖排）。 -->
    <div class="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-lg bg-black/40">
      <button
        type="button"
        class="text-muted-foreground hover:bg-white/10 hover:text-foreground flex size-8 items-center justify-center transition-colors"
        title="放大"
        aria-label="放大图片"
        onclick={(event) => {
          event.stopPropagation()
          zoomBy(1.25)
        }}
        data-testid="lightbox-zoom-in"
      >
        <IconPlus class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="text-muted-foreground hover:bg-white/10 hover:text-foreground flex size-8 items-center justify-center border-t border-white/10 transition-colors"
        title="缩小"
        aria-label="缩小图片"
        onclick={(event) => {
          event.stopPropagation()
          zoomBy(1 / 1.25)
        }}
        data-testid="lightbox-zoom-out"
      >
        <IconMinus class="size-4" aria-hidden="true" />
      </button>
    </div>
  </div>

  <!-- 底部信息条：名称 · 当前/总数 + 新窗口打开（原尺寸保底）+ 缩放百分比。
       （信息条无整条点击语义——空白处点击冒泡至背景即关闭；外链钮自带
       stopPropagation 防开新窗同时误关。） -->
  <div
    class="text-muted-foreground flex h-10 shrink-0 items-center gap-3 bg-black/50 px-4 text-xs"
    data-testid="lightbox-info"
  >
    <span class="min-w-0 truncate" title={items[current]?.name}>
      {items[current]?.name} · {current + 1}/{items.length}
    </span>
    <a
      href={items[current] !== undefined ? assetRawUrl(items[current].blobRef) : '#'}
      target="_blank"
      rel="noopener"
      class="hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md border border-white/15 px-2 transition-colors"
      title="在新窗口打开原图"
      onclick={(event) => event.stopPropagation()}
      data-testid="lightbox-open-external"
    >
      <IconExternalLink class="size-3" aria-hidden="true" />
      新窗口打开
    </a>
    <span class="ml-auto shrink-0 tabular-nums" data-testid="lightbox-zoom-label">{Math.round(zoom * 100)}%</span>
  </div>
</div>
