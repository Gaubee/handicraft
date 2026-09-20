<!--
 * DesignerShortcutsHelp.svelte——键位速查面板（design §3.7：单页全表；「?」键开关）。
 *
 * Orthogonal intents (max 1):
 * 1. [2026-09-21 redesign-designer-workbench 3.x] 已接线键位全表速查（数据单源
 *    SHORTCUT_HELP_SECTIONS——keymap 与面板同源）；Esc / 背景点击 / 关闭钮即关。
 *    图层操作组（⌘⇧N/⌘E/⌘[ ]）归 4.x 未接线不入表。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { SHORTCUT_HELP_SECTIONS } from '$lib/designer/keymap'
  import { setShortcutsHelpOpen } from '$lib/designer/viewState.svelte'

  function close(): void {
    setShortcutsHelpOpen(false)
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault()
      close()
    }
  }
  onMount(() => {
    window.addEventListener('keydown', onWindowKeydown, true)
    return () => window.removeEventListener('keydown', onWindowKeydown, true)
  })
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="designer-shortcuts-help">
  <!-- 背景点击关闭 -->
  <button type="button" class="absolute inset-0 cursor-default bg-black/40" aria-label="关闭键位速查" onclick={close}></button>
  <div class="bg-card relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border p-4 shadow-xl" role="dialog" aria-label="键位速查">
    <header class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold tracking-tight">键位速查</h3>
      <Button variant="ghost" size="icon-xs" onclick={close} data-testid="designer-shortcuts-help-close" aria-label="关闭">
        ✕
      </Button>
    </header>
    <div class="grid min-h-0 flex-1 gap-4 overflow-y-auto sm:grid-cols-2">
      {#each SHORTCUT_HELP_SECTIONS as section (section.title)}
        <section>
          <h4 class="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide">{section.title}</h4>
          <dl class="grid gap-1">
            {#each section.rows as row (row.label)}
              <div class="flex items-center justify-between gap-3 rounded px-1.5 py-1 text-xs odd:bg-muted/50">
                <dt class="font-mono text-[11px] tabular-nums">{row.keys}</dt>
                <dd class="text-right">{row.label}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
    <footer class="text-muted-foreground mt-3 text-[11px]">⌘ = Ctrl / Win 键；输入控件聚焦时快捷键一律放行表单。</footer>
  </div>
</div>
