<!--
WorkbenchShortcutsHelp.svelte — ? 键位速查面板（add-workbench-pro 2c——命令总线驱动）。
命令清单/快捷键/可用性全部来自 commands.ts 单源（getWorkbenchCommandRows——
菜单/按钮/键位同源纪律；无第二张键位表）。Esc 关闭（mode.exit 取消链最优先）。
-->

<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import { getWorkbenchCommandRows } from './commands.js'
  import { isHelpOpen, setHelpOpen } from './store.svelte'

  const open = $derived(isHelpOpen())
  const rows = $derived(getWorkbenchCommandRows())
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="workbench-shortcuts-help">
    <div class="bg-background w-full max-w-md rounded-lg border shadow-xl">
      <div class="flex h-10 items-center gap-2 border-b px-3">
        <span class="text-sm font-semibold">快捷键与命令速查</span>
        <span class="text-muted-foreground text-[10px]">命令总线单源（菜单/按钮/键位同源）</span>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground ml-auto rounded p-1"
          onclick={() => setHelpOpen(false)}
          aria-label="关闭速查（Esc）"
          data-testid="workbench-shortcuts-close"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
      <div class="scrollbar-thin max-h-[60vh] overflow-y-auto p-2">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-muted-foreground text-left text-[10px]">
              <th class="px-2 py-1 font-medium">命令</th>
              <th class="px-2 py-1 font-medium">快捷键</th>
              <th class="px-2 py-1 font-medium">当前可用</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr class="border-b last:border-b-0">
                <td class="px-2 py-1" data-testid="workbench-shortcut-title-{row.id}">{row.title}</td>
                <td class="px-2 py-1 font-mono text-[11px] whitespace-nowrap">{row.keys}</td>
                <td class="px-2 py-1">
                  {#if row.available}
                    <span class="text-emerald-600">可用</span>
                  {:else}
                    <span class="text-muted-foreground/60">不适用</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="text-muted-foreground border-t px-3 py-1.5 text-[10px]">
        输入框聚焦/IME 组字期间快捷键不拦截；⌘=Cmd/Ctrl 双平台。
      </div>
    </div>
  </div>
{/if}
