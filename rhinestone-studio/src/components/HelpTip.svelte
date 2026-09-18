<!--
Orthogonal intents (max 1):
1. [2026-09-18 R1 vision#6] 说明文字收纳：卡题行问号图标 + Tooltip 承载原文，
     替代铺满卡片的灰字噪音。禁止嵌进 button/accordion trigger 内部（HTML 不允许按钮嵌套）。
-->

<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip'
  import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark'

  let { text, label = '说明' }: { text: string; label?: string } = $props()
</script>

<Tooltip.Provider>
  <Tooltip.Root>
    <Tooltip.Trigger
      class="text-muted-foreground/60 hover:text-muted-foreground inline-flex shrink-0 transition-colors"
      aria-label={label}
    >
      <CircleQuestionMark class="size-3.5" />
    </Tooltip.Trigger>
    <Tooltip.Content side="top" class="max-w-64 text-xs leading-relaxed">
      {text}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
