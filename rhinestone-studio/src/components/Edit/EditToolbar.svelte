<!--
 * Orthogonal intents (max 2):
 * 1. [2026-09-20 C-3.1 rename-and-expert-workbench] 工具栏区：工具三态（选择/画钻/擦除，
 *    写 workbench 工具真源）+ snap 两态（格位/自由）+ 撤销/重做（⌘Z/⌘⇧Z 快捷键在
 *    editKeyboard；按钮为同一命令的可点入口）。类 PS 四区布局的顶部工具段。
 * 2. [2026-09-20 Guard] 无文档态全禁用（工具态无消费面）；撤销/重做随 undo 深度联动。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { canRedo, canUndo, getEditDoc, redo, undo } from '$lib/stores/edit.svelte'
  import { getSnap, getTool, setSnap, setTool } from '$lib/designer/workbench.svelte'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import Eraser from '@lucide/svelte/icons/eraser'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import Redo2 from '@lucide/svelte/icons/redo-2'

  const hasDoc = $derived(getEditDoc() !== null)
  const tool = $derived(getTool())
  const snap = $derived(getSnap())
  const undoable = $derived(canUndo())
  const redoable = $derived(canRedo())

  const TOOLS: Array<{ id: 'select' | 'draw' | 'erase'; label: string; icon: typeof MousePointer2 }> = [
    { id: 'select', label: '选择', icon: MousePointer2 },
    { id: 'draw', label: '画钻', icon: PenLine },
    { id: 'erase', label: '擦除', icon: Eraser },
  ]
</script>

<div
  class="flex items-center gap-1 rounded-lg border bg-card p-0.5 shadow-sm"
  data-testid="edit-toolbar"
  role="toolbar"
  aria-label="编辑工具"
>
  {#each TOOLS as t (t.id)}
    <Button
      size="icon-xs"
      variant={tool === t.id ? 'secondary' : 'ghost'}
      class="gap-1 px-1.5"
      disabled={!hasDoc}
      aria-pressed={tool === t.id}
      title={t.label}
      onclick={() => setTool(t.id)}
      data-testid={`edit-tool-${t.id}`}
    >
      <t.icon class="size-3.5" aria-hidden="true" />
      <span class="hidden text-[11px] xl:inline">{t.label}</span>
    </Button>
  {/each}

  <span class="bg-border mx-0.5 h-4 w-px" aria-hidden="true"></span>

  <div class="flex items-center gap-0.5" role="group" aria-label="吸附" data-testid="edit-snap-group">
    <Button
      size="xs"
      variant={snap === 'grid' ? 'secondary' : 'ghost'}
      class="h-6 px-1.5 text-[11px]"
      disabled={!hasDoc}
      aria-pressed={snap === 'grid'}
      title="吸附到六方格位（临时格：现行网格 pitch）"
      onclick={() => setSnap('grid')}
      data-testid="edit-snap-grid"
    >
      格位
    </Button>
    <Button
      size="xs"
      variant={snap === 'free' ? 'secondary' : 'ghost'}
      class="h-6 px-1.5 text-[11px]"
      disabled={!hasDoc}
      aria-pressed={snap === 'free'}
      title="自由落点（不吸附）"
      onclick={() => setSnap('free')}
      data-testid="edit-snap-free"
    >
      自由
    </Button>
  </div>

  <span class="bg-border mx-0.5 h-4 w-px" aria-hidden="true"></span>

  <Button
    size="icon-xs"
    variant="ghost"
    disabled={!undoable}
    title="撤销（⌘Z / Ctrl+Z）"
    onclick={() => undo()}
    data-testid="edit-undo"
  >
    <Undo2 />
  </Button>
  <Button
    size="icon-xs"
    variant="ghost"
    disabled={!redoable}
    title="重做（⌘⇧Z / Ctrl+Shift+Z）"
    onclick={() => redo()}
    data-testid="edit-redo"
  >
    <Redo2 />
  </Button>
</div>
