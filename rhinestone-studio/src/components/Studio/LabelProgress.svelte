<!--
[2026-09-19 Busy 原语] 非按钮耗时项的 label 承载（Owner 裁决：不是 button 但有 label → label 承载状态）：
idle 文案 ↔ busy 文案（「计算中…」等）+ 可选分数计数（3/6）；busy 态 pulse；
title 携带完整进度描述（收起/截断也能核对阶段）；aria-live=polite 供读屏播报状态切换。
-->

<script lang="ts">
  interface Progress {
    done: number
    total: number
    label: string
  }

  let {
    text,
    busy = false,
    busyText = '计算中…',
    progress = null,
    class: className = '',
  }: {
    /** idle 文案（正常态显示的当前值/摘要） */
    text: string
    busy?: boolean
    /** busy 态替换文案（默认「计算中…」；分块等阶段可传「分块中…」） */
    busyText?: string
    /** 可选进度（total>1 时追加分数计数；label 进 title） */
    progress?: Progress | null
    class?: string
  } = $props()

  const showFraction = $derived(busy && progress !== null && progress.total > 1)
  const titleText = $derived(
    busy && progress !== null ? `${progress.label} ${progress.done}/${progress.total}` : text,
  )
</script>

<span
  class="tabular-nums {className}"
  class:animate-pulse={busy}
  class:text-muted-foreground={busy}
  aria-live="polite"
  aria-busy={busy ? 'true' : undefined}
  title={titleText}
>{busy ? busyText : text}{#if showFraction}&nbsp;{progress!.done}/{progress!.total}{/if}</span>
